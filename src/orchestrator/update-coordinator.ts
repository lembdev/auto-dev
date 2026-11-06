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
// How long running Turns get to finish before the updater interrupts them.
export const TURN_WAIT_TIMEOUT_MS = 10 * 60_000;
export const TURN_WAIT_POLL_MS = 5_000;
// A requested update that never reached the preparation step (no newer release, a failed download)
// stops showing as in progress after this.
export const REQUEST_TTL_MS = 10 * 60_000;
export const UPDATE_PAUSE_REASON = "the Installation is being updated";

// What the UI runs through sudo: the engine's `update` in a transient unit of its own, so stopping
// auto-dev.service does not kill the updater as a child of the service. Silent mode: there is no terminal.
export const UPDATE_COMMAND = {
  command: "sudo",
  args: ["-n", "/usr/bin/systemd-run", "--unit=auto-dev-update", "--collect", "--setenv=PHS_SILENT=1", "/usr/bin/update"],
} as const;

export type UpdatePhase = "idle" | "requested" | "preparing" | "ready";

export type UpdateView = {
  current: string;
  latest: string | null;
  latestUrl: string | null;
  available: boolean;
  checkedAt: string | null;
  phase: UpdatePhase;
  phaseSince: string | null;
};

type LatestRecord = { version: string; htmlUrl: string; checkedAt: string };
type PhaseRecord = { phase: Exclude<UpdatePhase, "idle">; since: string };

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

  // The process (re)started: whatever update was under way is over, the Pause it set is lifted.
  start(): void {
    if (this._started) return;
    this._started = true;
    const phase = this._readPhase();
    if (phase) {
      this._index.installation.delete(UPDATE_KEYS.phase);
      this._log.info({ phase: phase.phase, since: phase.since }, "update finished with this start");
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
    };
  }

  phase(): UpdatePhase {
    return this.view().phase;
  }

  // Once per polling cycle; GitHub is asked at most once a day. A failed check keeps the previous answer.
  async checkRelease(): Promise<void> {
    const latest = this._readLatest();
    if (latest && Date.parse(latest.checkedAt) + RELEASE_CHECK_INTERVAL_MS > this._clock.now()) return;
    let release;
    try {
      release = await this._releases.findLatest();
    } catch (error) {
      this._log.warn({ err: error }, "release check failed");
      return;
    }
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

  // "Обновить" in the UI: the updater starts detached and comes back for the preparation itself.
  async request(): Promise<UpdateView> {
    const phase = this.phase();
    if (phase !== "idle") throw new UpdateInProgressError(phase);
    const pid = await this._processes.spawnDetached(UPDATE_COMMAND.command, UPDATE_COMMAND.args);
    this._writePhase("requested");
    this._log.info({ pid, latest: this.view().latest }, "update started");
    return this.view();
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
    this._writePhase("preparing");
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
    this._writePhase("ready");
    this._log.info({ interrupted: running.length }, "ready for the update");
  }

  private _runningIds(): AgentId[] {
    return this._runner.liveIds().filter((id) => this._runner.find(id)?.state === "running");
  }

  private _writePhase(phase: PhaseRecord["phase"]): void {
    const record: PhaseRecord = { phase, since: this._iso() };
    this._index.installation.set(UPDATE_KEYS.phase, JSON.stringify(record));
  }

  private _readPhase(): PhaseRecord | undefined {
    const record = this._readJson<PhaseRecord>(UPDATE_KEYS.phase);
    if (!record) return undefined;
    if (record.phase === "requested" && Date.parse(record.since) + REQUEST_TTL_MS <= this._clock.now()) return undefined;
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
