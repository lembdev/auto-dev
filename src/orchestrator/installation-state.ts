import { USAGE_LIMIT_ERROR_PREFIXES, type SDKMessage, type SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../agents/agent-runner.js";
import type { AgentId } from "../ids.js";
import type { AgentRecord } from "../index/agents.js";
import type { LimitReading, LimitSample } from "../index/limit-samples.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import { parseRateLimitsFile, rateLimitsFilePath } from "../limits/rate-limits-file.js";
import type { Logger } from "../log.js";
import type { Clock, TimerHandle } from "../ports/clock.js";
import type { DiskPort, DiskUsage } from "../ports/disk.js";
import type { DriverPort } from "../ports/driver.js";
import { ClaudeVersionGuard, type ClaudeVersionView } from "./claude-version.js";

// Past the reset time the subscription may lag a little before it accepts requests again.
export const WALL_MARGIN_MS = 2 * 60_000;
// A rejection right after the reset means the window has not really opened yet.
export const WALL_RETRY_MS = 5 * 60_000;
export const PREARM_THRESHOLD_PERCENT = 95;
export const DISK_PAUSE_THRESHOLD_PERCENT = 90;
export const SAMPLE_INTERVAL_MS = 10 * 60_000;
export const SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60_000;

// Keys in the `installation` table owned by this module.
export const INSTALLATION_STATE_KEYS = {
  pause: "pause",
  wall: "limit.wall",
  fiveHour: "limit.five_hour",
  sevenDay: "limit.seven_day",
  prearmEnabled: "prearm_enabled",
} as const;

export const PAUSE_SOURCES = ["human", "update", "disk", "token"] as const;
export type PauseSource = (typeof PAUSE_SOURCES)[number];

export type Pause = {
  source: PauseSource;
  reason: string;
  since: string;
};

// The Installation at the limit: no new Turn until `until`; the Turns cut short are resumed then.
export type Wall = {
  since: string;
  until: string;
  resetsAt: string | null;
  interrupted: AgentId[];
  rejections: number;
};

export type Limits = {
  fiveHour: LimitReading | null;
  sevenDay: LimitReading | null;
};

type LimitWindow = keyof Limits;

export type StartBlocker = "paused" | "at_limit" | "prearm" | "claude_version";

export type InstallationSnapshot = {
  paused: boolean;
  pause: Pause | null;
  atLimit: Omit<Wall, "interrupted"> | null;
  limits: Limits;
  prearm: { enabled: boolean; thresholdPercent: number; active: boolean };
  disk: DiskUsage | null;
  claudeVersion: ClaudeVersionView;
  blocker: StartBlocker | null;
  canStartTurn: boolean;
};

export type InstallationStateOptions = {
  index: RuntimeIndex;
  clock: Clock;
  disk: DiskPort;
  driver: DriverPort;
  runner: AgentRunner;
  log: Logger;
  // Data directory of the Installation: its disk is watched and the statusline file read from it.
  dataDir: string;
};

const WINDOW_OF: Partial<Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, LimitWindow>> = {
  five_hour: "fiveHour",
  seven_day: "sevenDay",
};

const KEY_OF: Record<LimitWindow, string> = {
  fiveHour: INSTALLATION_STATE_KEYS.fiveHour,
  sevenDay: INSTALLATION_STATE_KEYS.sevenDay,
};

// The SDK leaves the unit of `utilization` open; a value within [0, 1] is read as a fraction.
const percentOf = (utilization: number): number => {
  const percent = utilization <= 1 ? utilization * 100 : utilization;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
};

// Reset times come as Unix seconds from the statusline and the CLI; milliseconds are accepted too.
const toEpochMs = (raw: number | undefined): number | undefined => {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return raw < 1e12 ? raw * 1000 : raw;
};

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const usageLimitText = (message: Extract<SDKMessage, { type: "result" }>): string[] =>
  message.subtype === "success" ? [message.result] : message.errors;

export const isUsageLimitError = (message: SDKMessage): boolean =>
  message.type === "result" &&
  message.is_error &&
  usageLimitText(message).some((text) => USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.trimStart().startsWith(prefix)));

// Pause, the subscription limit, the disk and the CLI version of the Installation: everything that
// decides whether a new Turn may start. Lives in the `installation` table so it survives a restart.
export class InstallationState {
  private readonly _index: RuntimeIndex;
  private readonly _clock: Clock;
  private readonly _disk: DiskPort;
  private readonly _runner: AgentRunner;
  private readonly _log: Logger;
  private readonly _dataDir: string;
  private readonly _claudeVersion: ClaudeVersionGuard;
  private _lastDisk: DiskUsage | undefined;
  private _wallTimer: TimerHandle | undefined;
  private _sampleTimer: TimerHandle | undefined;

  constructor(options: InstallationStateOptions) {
    this._index = options.index;
    this._clock = options.clock;
    this._disk = options.disk;
    this._runner = options.runner;
    this._log = options.log;
    this._dataDir = options.dataDir;
    this._claudeVersion = new ClaudeVersionGuard({
      installation: this._index.installation,
      driver: options.driver,
      clock: this._clock,
      log: this._log,
      cwd: this._dataDir,
    });
    this._runner.onMessage((agent, message) => this._observe(agent, message));
  }

  // The `claude` CLI under the Installation: its last known good version and the smoke query on a change.
  get claudeVersion(): ClaudeVersionGuard {
    return this._claudeVersion;
  }

  // Pause

  pause(source: PauseSource, reason: string): Pause {
    const pause: Pause = { source, reason, since: iso(this._clock.now()) };
    this._index.installation.set(INSTALLATION_STATE_KEYS.pause, JSON.stringify(pause));
    this._log.warn({ source, reason }, "installation paused");
    return pause;
  }

  unpause(): void {
    if (!this.paused()) return;
    this._index.installation.delete(INSTALLATION_STATE_KEYS.pause);
    this._log.info("installation resumed");
  }

  findPause(): Pause | undefined {
    return this._readJson<Pause>(INSTALLATION_STATE_KEYS.pause);
  }

  paused(): boolean {
    return this.findPause() !== undefined;
  }

  // The limit

  findWall(): Wall | undefined {
    return this._readJson<Wall>(INSTALLATION_STATE_KEYS.wall);
  }

  atLimit(): boolean {
    const wall = this.findWall();
    return wall !== undefined && Date.parse(wall.until) > this._clock.now();
  }

  limits(): Limits {
    return { fiveHour: this._reading("fiveHour") ?? null, sevenDay: this._reading("sevenDay") ?? null };
  }

  prearmEnabled(): boolean {
    return this._index.installation.find(INSTALLATION_STATE_KEYS.prearmEnabled) !== "false";
  }

  setPrearmEnabled(enabled: boolean): void {
    this._index.installation.set(INSTALLATION_STATE_KEYS.prearmEnabled, enabled ? "true" : "false");
  }

  // The five hour window is nearly used up: better to wait for the reset than to start a Turn
  // that gets rejected halfway. A reading from before the reset no longer counts.
  prearmed(): boolean {
    if (!this.prearmEnabled()) return false;
    const fiveHour = this._reading("fiveHour");
    if (!fiveHour) return false;
    if (fiveHour.resetsAt !== null && Date.parse(fiveHour.resetsAt) <= this._clock.now()) return false;
    return fiveHour.usedPercent >= PREARM_THRESHOLD_PERCENT;
  }

  blocker(): StartBlocker | undefined {
    if (this.paused()) return "paused";
    if (this.atLimit()) return "at_limit";
    if (this.prearmed()) return "prearm";
    if (this._claudeVersion.blocked()) return "claude_version";
    return undefined;
  }

  canStartTurn(): boolean {
    return this.blocker() === undefined;
  }

  disk(): DiskUsage | undefined {
    return this._lastDisk;
  }

  snapshot(): InstallationSnapshot {
    const pause = this.findPause() ?? null;
    const wall = this.atLimit() ? this.findWall() : undefined;
    const blocker = this.blocker() ?? null;
    return {
      paused: pause !== null,
      pause,
      atLimit: wall ? { since: wall.since, until: wall.until, resetsAt: wall.resetsAt, rejections: wall.rejections } : null,
      limits: this.limits(),
      prearm: { enabled: this.prearmEnabled(), thresholdPercent: PREARM_THRESHOLD_PERCENT, active: this.prearmed() },
      disk: this._lastDisk ?? null,
      claudeVersion: this._claudeVersion.view(),
      blocker,
      canStartTurn: blocker === null,
    };
  }

  // Once per polling cycle, before any new Agent: the disk, the statusline file, a limit that has
  // reset meanwhile, the CLI version.
  async check(): Promise<void> {
    this._armSampling();
    await this._checkDisk();
    await this._readStatusLineFile();
    await this._settleWall();
    await this._claudeVersion.check();
  }

  // Writes the current readings into `limit_samples` and drops the ones past retention.
  sample(): LimitSample | undefined {
    const now = this._clock.now();
    this._index.limitSamples.deleteBefore(iso(now - SAMPLE_RETENTION_MS));
    const limits = this.limits();
    if (limits.fiveHour === null && limits.sevenDay === null) return undefined;
    return this._index.limitSamples.insert({ at: iso(now), ...limits });
  }

  stop(): void {
    if (this._wallTimer !== undefined) this._clock.clear(this._wallTimer);
    if (this._sampleTimer !== undefined) this._clock.clear(this._sampleTimer);
    this._wallTimer = undefined;
    this._sampleTimer = undefined;
  }

  // Internals

  private _observe(agent: AgentRecord, message: SDKMessage): void {
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      if (info.status === "rejected") {
        void this._enterWall(agent, info.resetsAt, "rate_limit_event rejected");
        return;
      }
      this._recordEvent(info);
      return;
    }
    if (isUsageLimitError(message)) {
      void this._enterWall(agent, undefined, "usage limit error result");
      return;
    }
    if (message.type === "system" && message.subtype === "api_retry" && message.error === "authentication_failed" && !this.paused()) {
      this.pause("token", "the Claude OAuth token was rejected; run `claude setup-token` and store the new token on the Settings page");
    }
  }

  private _recordEvent(info: SDKRateLimitInfo): void {
    const window = info.rateLimitType ? WINDOW_OF[info.rateLimitType] : undefined;
    if (!window || info.utilization === undefined) return;
    const resetsAt = toEpochMs(info.resetsAt);
    this._record(window, {
      usedPercent: percentOf(info.utilization),
      resetsAt: resetsAt === undefined ? null : iso(resetsAt),
      at: iso(this._clock.now()),
      source: "event",
    });
  }

  // The freshest reading of a window wins, whichever source it came from.
  private _record(window: LimitWindow, reading: LimitReading): void {
    const current = this._reading(window);
    if (current && Date.parse(current.at) > Date.parse(reading.at)) return;
    this._index.installation.set(KEY_OF[window], JSON.stringify(reading));
  }

  private _reading(window: LimitWindow): LimitReading | undefined {
    return this._readJson<LimitReading>(KEY_OF[window]);
  }

  private async _enterWall(trigger: AgentRecord, resetsAtRaw: number | undefined, cause: string): Promise<void> {
    const now = this._clock.now();
    const resetsAt = toEpochMs(resetsAtRaw);
    const computed = resetsAt !== undefined && resetsAt + WALL_MARGIN_MS > now ? resetsAt + WALL_MARGIN_MS : now + WALL_RETRY_MS;
    const existing = this.findWall();
    const until = Math.max(computed, existing ? Date.parse(existing.until) : 0);
    const interrupted = new Set<AgentId>(existing?.interrupted ?? []);
    const live = this._runner.liveIds();
    for (const id of live) {
      if (id === trigger.id || this._runner.find(id)?.state === "running") interrupted.add(id);
    }
    const wall: Wall = {
      since: existing?.since ?? iso(now),
      until: iso(until),
      resetsAt: resetsAt === undefined ? null : iso(resetsAt),
      interrupted: [...interrupted],
      rejections: (existing?.rejections ?? 0) + 1,
    };
    this._index.installation.set(INSTALLATION_STATE_KEYS.wall, JSON.stringify(wall));
    this._log.warn({ cause, agent: trigger.id, until: wall.until, resetsAt: wall.resetsAt, stopping: live.length }, "subscription limit reached");
    this._armWallTimer(until - now);
    await Promise.all(
      live.map((id) =>
        this._runner.stop(id).catch((error: unknown) => this._log.error({ err: error, agent: id }, "stop at the limit failed")),
      ),
    );
  }

  // Past `until` the Turns cut short continue in their Sessions; nothing is started from scratch.
  private async _settleWall(): Promise<void> {
    const wall = this.findWall();
    if (!wall) return;
    const remaining = Date.parse(wall.until) - this._clock.now();
    if (remaining > 0) {
      if (this._wallTimer === undefined) this._armWallTimer(remaining);
      return;
    }
    this._index.installation.delete(INSTALLATION_STATE_KEYS.wall);
    this._log.info({ interrupted: wall.interrupted.length }, "subscription limit reset, resuming interrupted turns");
    for (const id of wall.interrupted) {
      const record = this._runner.find(id);
      if (!record || record.state !== "stopped" || record.sessionId === null) continue;
      try {
        this._runner.resume(id, { resumeInterruptedTurn: true });
      } catch (error) {
        this._log.error({ err: error, agent: id }, "interrupted turn not resumed");
      }
    }
  }

  private _armWallTimer(ms: number): void {
    if (this._wallTimer !== undefined) this._clock.clear(this._wallTimer);
    this._wallTimer = this._clock.setTimeout(() => {
      this._wallTimer = undefined;
      this._settleWall().catch((error: unknown) => this._log.error({ err: error }, "leaving the limit failed"));
    }, Math.max(0, ms));
  }

  private _armSampling(): void {
    if (this._sampleTimer !== undefined) return;
    this._sampleTimer = this._clock.setInterval(() => {
      this._readStatusLineFile()
        .then(() => {
          this.sample();
        })
        .catch((error: unknown) => this._log.error({ err: error }, "limit sample failed"));
    }, SAMPLE_INTERVAL_MS);
  }

  private async _checkDisk(): Promise<void> {
    let usage: DiskUsage;
    try {
      usage = await this._disk.usage(this._dataDir);
    } catch (error) {
      this._log.error({ err: error, path: this._dataDir }, "disk usage unknown");
      return;
    }
    this._lastDisk = usage;
    if (usage.usedPercent < DISK_PAUSE_THRESHOLD_PERCENT || this.paused()) return;
    this.pause("disk", `disk at ${this._dataDir} is ${usage.usedPercent} % full (threshold ${DISK_PAUSE_THRESHOLD_PERCENT} %)`);
  }

  private async _readStatusLineFile(): Promise<void> {
    const content = await this._disk.readFile(rateLimitsFilePath(this._dataDir));
    if (content === undefined) return;
    const file = parseRateLimitsFile(content);
    if (!file) return;
    for (const [window, raw] of [
      ["fiveHour", file.five_hour],
      ["sevenDay", file.seven_day],
    ] as const) {
      if (!raw) continue;
      this._record(window, { usedPercent: raw.used_percentage, resetsAt: iso(raw.resets_at * 1000), at: file.updated_at, source: "statusline" });
    }
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
}
