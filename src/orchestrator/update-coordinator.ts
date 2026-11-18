import type { AgentRunner } from "../agents/agent-runner.js";
import type { AgentId } from "../ids.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { ProcessPort } from "../ports/process.js";
import type { ReleasesPort } from "../ports/releases.js";
import type { InstallationState } from "./installation-state.js";
import type { Recovery } from "./recovery.js";

// Keys in the `installation` table owned by this module.
export const UPDATE_KEYS = {
  latest: "update.latest",
  phase: "update.phase",
} as const;

export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
// After a failed check GitHub is asked again no sooner than this, not on every polling cycle.
export const RELEASE_RETRY_MS = 60 * 60_000;
// How long running Turns get to finish before the updater interrupts them.
export const TURN_WAIT_TIMEOUT_MS = 10 * 60_000;
export const TURN_WAIT_POLL_MS = 5_000;
// An update started from the console has no unit to watch: a request that never reached the preparation
// stops showing as in progress after this. For the button's unit it is how long an unreadable state is tolerated.
export const REQUEST_TTL_MS = 10 * 60_000;
export const UPDATE_PAUSE_REASON = "the Installation is being updated";
// Lines of the updater's journal kept with a failure.
export const FAILURE_LOG_LINES = 40;

// The transient unit the button runs the updater in.
export const UPDATE_UNIT = "auto-dev-update";

// What the UI runs through sudo: the engine's `update` in a transient unit of its own, so stopping
// auto-dev.service does not kill the updater as a child of the service. systemd-run returns once the unit
// has started, so a refused sudo or a unit that cannot start shows as its exit code. Silent mode: there is no terminal;
// TERM: a transient unit has none, and the engine's `clear` fails without it, which under errexit ends the update
// on its first line; HOME: the engine keeps the installed version in `~/.auto-dev` of root.
// The sudoers rule matches these exact arguments.
export const UPDATE_COMMAND = {
  command: "sudo",
  args: ["-n", "/usr/bin/systemd-run", `--unit=${UPDATE_UNIT}`, "--collect", "--setenv=PHS_SILENT=1", "--setenv=TERM=linux", "--setenv=HOME=/root", "/usr/bin/update"],
} as const;

// Reading the state of a unit needs no privileges. `--collect` unloads the unit once it ends,
// so anything but these states means the updater is gone.
export const UNIT_STATE_COMMAND = { command: "systemctl", args: ["is-active", UPDATE_UNIT] } as const;
const UNIT_RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading"]);

// The updater's output; its journal is root's to read, the sudoers rule allows this unit only.
export const journalCommand = (sinceMs: number): { command: string; args: string[] } => ({
  command: "sudo",
  args: ["-n", "/usr/bin/journalctl", "-u", UPDATE_UNIT, "--since", `@${Math.floor(sinceMs / 1000)}`, "-n", String(FAILURE_LOG_LINES), "-o", "cat", "--no-pager"],
});

export type UpdatePhase = "idle" | "requested" | "preparing" | "ready" | "failed";

export type UpdateView = {
  current: string;
  latest: string | null;
  latestUrl: string | null;
  available: boolean;
  checkedAt: string | null;
  phase: UpdatePhase;
  phaseSince: string | null;
  // Why the last update did not happen; set in the `failed` phase only.
  error: string | null;
  // The tail of the updater's output for that failure, empty while it is not read yet or there is none.
  log: string[];
};

type LatestRecord = { version: string; htmlUrl: string; checkedAt: string };
type PhaseRecord = {
  phase: Exclude<UpdatePhase, "idle">;
  since: string;
  // The version that ran when the update began: a restart on the same one means it did not install.
  from?: string;
  // Started by the button in the transient unit, which can be watched and whose journal can be read.
  unit?: boolean;
  startedAt?: string;
  error?: string;
  log?: string[];
  // The failure is recorded, its journal is read once the updater has ended.
  logPending?: boolean;
};

export type UpdateCoordinatorOptions = {
  index: RuntimeIndex;
  clock: Clock;
  runner: AgentRunner;
  recovery: Recovery;
  installation: InstallationState;
  releases: ReleasesPort;
  processes: ProcessPort;
  log: Logger;
  // Version of the running code, from package.json.
  version: string;
};

export class UpdateInProgressError extends Error {
  constructor(readonly phase: UpdatePhase) {
    super(`an update is already in progress (${phase})`);
    this.name = "UpdateInProgressError";
  }
}

// Colours and cursor moves of the engine's spinner, and what a carriage return wrote over.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
export const cleanLogLines = (output: string): string[] =>
  output
    .split("\n")
    .map((line) => (line.split("\r").filter((part) => part.trim() !== "").at(-1) ?? "").replace(ANSI, "").trimEnd())
    .filter((line) => line.trim() !== "");

// Semantic version order; a pre-release ranks below the release it precedes.
export const compareVersions = (a: string, b: string): number => {
  const parse = (version: string): { core: number[]; pre: string | undefined } => {
    const [core = "", pre] = version.split("-", 2);
    return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
};

// Updating the Installation: the daily look at the GitHub Releases, the button that starts the updater,
// and the preparation the updater asks for before it stops the service: Pause, running Turns allowed to
// finish within the timeout, then interrupted. The phase lives in the index so every tab sees it.
export class UpdateCoordinator {
  private readonly _index: RuntimeIndex;
  private readonly _clock: Clock;
  private readonly _runner: AgentRunner;
  private readonly _recovery: Recovery;
  private readonly _installation: InstallationState;
  private readonly _releases: ReleasesPort;
  private readonly _processes: ProcessPort;
  private readonly _log: Logger;
  private readonly _version: string;
  private _preparing: Promise<void> | undefined;
  private _started = false;
  private _failedAt: number | undefined;

  constructor(options: UpdateCoordinatorOptions) {
    this._index = options.index;
    this._clock = options.clock;
    this._runner = options.runner;
    this._recovery = options.recovery;
    this._installation = options.installation;
    this._releases = options.releases;
    this._processes = options.processes;
    this._log = options.log;
    this._version = options.version;
  }

  // The process (re)started: whatever update was under way is over, the Pause it set is lifted. A start on the
  // version the update began from means the new one did not install: the updater put the old release back.
  start(): void {
    if (this._started) return;
    this._started = true;
    const record = this._readPhase();
    if (record?.phase === "requested" && record.unit) {
      // The updater has not stopped the service yet; the unit is watched as before.
    } else if (record && record.phase !== "failed") {
      if (record.from !== undefined && record.from === this._version && record.phase !== "requested") {
        this._fail(record, `сервис перезапущен на прежней версии ${this._version}: новая версия не установилась`);
      } else {
        this._index.installation.delete(UPDATE_KEYS.phase);
        this._log.info({ phase: record.phase, since: record.since }, "update finished with this start");
      }
    }
    if (this._installation.findPause()?.source === "update") this._installation.unpause();
  }

  view(): UpdateView {
    const latest = this._readLatest();
    const phase = this._readPhase();
    return {
      current: this._version,
      latest: latest?.version ?? null,
      latestUrl: latest?.htmlUrl ?? null,
      available: latest !== undefined && compareVersions(latest.version, this._version) > 0,
      checkedAt: latest?.checkedAt ?? null,
      phase: phase?.phase ?? "idle",
      phaseSince: phase?.since ?? null,
      error: phase?.phase === "failed" ? (phase.error ?? null) : null,
      log: phase?.phase === "failed" ? (phase.log ?? []) : [],
    };
  }

  phase(): UpdatePhase {
    return this.view().phase;
  }

  // Once per polling cycle; GitHub is asked at most once a day. A failed check keeps the previous answer.
  async checkRelease(): Promise<void> {
    const latest = this._readLatest();
    if (latest && Date.parse(latest.checkedAt) + RELEASE_CHECK_INTERVAL_MS > this._clock.now()) return;
    if (this._failedAt !== undefined && this._failedAt + RELEASE_RETRY_MS > this._clock.now()) return;
    let release;
    try {
      release = await this._releases.findLatest();
    } catch (error) {
      this._failedAt = this._clock.now();
      this._log.warn({ err: error }, "release check failed");
      return;
    }
    this._failedAt = undefined;
    const checkedAt = this._iso();
    if (!release) {
      this._index.installation.delete(UPDATE_KEYS.latest);
      this._log.info({ current: this._version }, "no release published yet");
      return;
    }
    const record: LatestRecord = { version: release.version, htmlUrl: release.htmlUrl, checkedAt };
    this._index.installation.set(UPDATE_KEYS.latest, JSON.stringify(record));
    if (compareVersions(release.version, this._version) > 0) {
      this._log.info({ current: this._version, latest: release.version }, "a newer release is available");
    }
  }

  // "Обновить" in the UI: the updater starts in its unit and comes back for the preparation itself.
  // A refused sudo or a unit that does not start is an error of the request, with what sudo said.
  async request(): Promise<UpdateView> {
    const phase = this.phase();
    if (phase !== "idle" && phase !== "failed") throw new UpdateInProgressError(phase);
    const result = await this._processes.run(UPDATE_COMMAND.command, UPDATE_COMMAND.args);
    if (result.code !== 0) {
      const reason = cleanLogLines(result.stderr)[0] ?? `systemd-run exited with ${result.code}`;
      this._log.error({ code: result.code, stderr: result.stderr }, "the updater did not start");
      throw new Error(reason);
    }
    const now = this._iso();
    this._writePhase({ phase: "requested", from: this._version, unit: true, startedAt: now });
    this._log.info({ latest: this.view().latest }, "update started");
    return this.view();
  }

  // "Скрыть" on a failed update: the banner goes, the offer of the newer release comes back.
  dismiss(): UpdateView {
    if (this._readPhase()?.phase === "failed") this._index.installation.delete(UPDATE_KEYS.phase);
    return this.view();
  }

  // Once per polling cycle: the button's updater that ended while this process still runs did not update it.
  // Its journal is read once it has ended, for the failure recorded here or at the start.
  async checkUnit(): Promise<void> {
    const record = this._readPhase();
    if (!record?.unit) return;
    const watching = record.phase === "requested" || record.phase === "preparing" || record.phase === "ready";
    if (!watching && !(record.phase === "failed" && record.logPending)) return;
    const state = await this._unitState();
    if (state === undefined) {
      if (watching && Date.parse(record.since) + REQUEST_TTL_MS <= this._clock.now()) {
        this._fail(record, "не удалось узнать состояние обновителя");
      }
      return;
    }
    if (UNIT_RUNNING_STATES.has(state)) return;
    const failed = watching ? this._fail(record, "обновитель завершился, не перезапустив сервис") : record;
    await this._readFailureLog(failed);
  }

  // The updater is about to stop the service: new Turns are off, the running ones get their time,
  // then the rest is interrupted. Resolves once the service may be stopped.
  prepare(): Promise<void> {
    this._preparing ??= this._prepare().finally(() => {
      this._preparing = undefined;
    });
    return this._preparing;
  }

  private async _prepare(): Promise<void> {
    if (this.phase() === "ready") return;
    if (!this._installation.paused()) this._installation.pause("update", UPDATE_PAUSE_REASON);
    // The button's run keeps its unit; an update from the console starts its record here.
    const previous = this._readPhase();
    const carried = previous && previous.phase !== "failed" ? previous : undefined;
    this._writePhase({ ...this._carry(carried), phase: "preparing" });
    const deadline = this._clock.now() + TURN_WAIT_TIMEOUT_MS;
    let running = this._runningIds();
    while (running.length > 0 && this._clock.now() < deadline) {
      await this._clock.sleep(Math.min(TURN_WAIT_POLL_MS, deadline - this._clock.now()));
      running = this._runningIds();
    }
    if (running.length > 0) {
      // The Turns cut short here continue in their Sessions after the restart.
      this._recovery.rememberRunning();
      this._log.warn({ agents: running }, "turns still running at the update timeout, interrupting them");
      await Promise.all(
        running.map((id) => this._runner.interrupt(id).catch((error: unknown) => this._log.error({ err: error, agent: id }, "interrupt for the update failed"))),
      );
    }
    this._writePhase({ ...this._carry(this._readPhase()), phase: "ready" });
    this._log.info({ interrupted: running.length }, "ready for the update");
  }

  private _runningIds(): AgentId[] {
    return this._runner.liveIds().filter((id) => this._runner.find(id)?.state === "running");
  }

  // What an update keeps from phase to phase.
  private _carry(record: PhaseRecord | undefined): Pick<PhaseRecord, "from" | "unit" | "startedAt"> {
    return {
      from: record?.from ?? this._version,
      ...(record?.unit ? { unit: true } : {}),
      ...(record?.startedAt ? { startedAt: record.startedAt } : {}),
    };
  }

  private _fail(record: PhaseRecord, error: string): PhaseRecord {
    const failed: PhaseRecord = { ...this._carry(record), phase: "failed", since: this._iso(), error, log: [], ...(record.unit ? { logPending: true } : {}) };
    this._index.installation.set(UPDATE_KEYS.phase, JSON.stringify(failed));
    if (this._installation.findPause()?.source === "update") this._installation.unpause();
    this._log.error({ error, from: record.phase, since: record.since }, "update failed");
    return failed;
  }

  private async _readFailureLog(record: PhaseRecord): Promise<void> {
    const since = Date.parse(record.startedAt ?? record.since);
    const { command, args } = journalCommand(Number.isNaN(since) ? this._clock.now() : since);
    let log: string[] = [];
    try {
      const result = await this._processes.run(command, args);
      log = result.code === 0 ? cleanLogLines(result.stdout) : [`журнал ${UPDATE_UNIT} не прочитан: ${cleanLogLines(result.stderr)[0] ?? `exit ${result.code}`}`];
    } catch (error) {
      log = [`журнал ${UPDATE_UNIT} не прочитан: ${error instanceof Error ? error.message : String(error)}`];
    }
    const current = this._readPhase();
    // Dismissed or replaced by another update while the journal was read.
    if (current?.phase !== "failed" || current.since !== record.since) return;
    const { logPending: _, ...rest } = current;
    this._index.installation.set(UPDATE_KEYS.phase, JSON.stringify({ ...rest, log: log.slice(-FAILURE_LOG_LINES) }));
  }

  private async _unitState(): Promise<string | undefined> {
    try {
      const result = await this._processes.run(UNIT_STATE_COMMAND.command, UNIT_STATE_COMMAND.args);
      // `is-active` exits non-zero for every state but active and still prints it.
      return result.stdout.trim() || undefined;
    } catch (error) {
      this._log.warn({ err: error }, "the state of the updater unit is unknown");
      return undefined;
    }
  }

  private _writePhase(record: Omit<PhaseRecord, "since">): void {
    this._index.installation.set(UPDATE_KEYS.phase, JSON.stringify({ ...record, since: this._iso() }));
  }

  private _readPhase(): PhaseRecord | undefined {
    const record = this._readJson<PhaseRecord>(UPDATE_KEYS.phase);
    if (!record) return undefined;
    if (record.phase === "requested" && !record.unit && Date.parse(record.since) + REQUEST_TTL_MS <= this._clock.now()) return undefined;
    return record;
  }

  private _readLatest(): LatestRecord | undefined {
    return this._readJson<LatestRecord>(UPDATE_KEYS.latest);
  }

  private _readJson<T>(key: string): T | undefined {
    const raw = this._index.installation.find(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this._log.warn({ key }, "installation value is not JSON, ignoring it");
      return undefined;
    }
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}
