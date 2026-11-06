import type { InstallationStore } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { DriverPort } from "../ports/driver.js";

// Keys in the `installation` table owned by this module.
export const CLAUDE_VERSION_KEYS = {
  lastKnownGood: "claude.last_known_good",
  smokeFailure: "claude.smoke_failure",
} as const;

export type ClaudeVersionStatus = "ok" | "failed";

// A smoke query that failed on this version of the CLI; `version` is null when the CLI did not even
// report one.
export type SmokeFailure = {
  version: string | null;
  error: string;
  at: string;
};

export type ClaudeVersionView = {
  // Version seen at the last check of this process; null before the first one.
  current: string | null;
  lastKnownGood: string | null;
  status: ClaudeVersionStatus;
  error: string | null;
  // What the human runs to go back to the last version that passed; null when none is known.
  rollbackCommand: string | null;
  checkedAt: string | null;
};

export type ClaudeVersionGuardOptions = {
  installation: InstallationStore;
  driver: DriverPort;
  clock: Clock;
  log: Logger;
  // Where the smoke query runs; the data directory keeps it out of the Product.
  cwd: string;
};

// The native installer takes a version as its target: `claude install 2.1.318`.
export const rollbackCommandFor = (version: string): string => `claude install ${version}`;

// A smoke query passed on this version (the wizard, the Settings page): nothing blocks new Agents
// because of the CLI any more. Without a version only the failure is forgotten.
export const markClaudeVersionVerified = (installation: InstallationStore, version: string | null): void => {
  installation.delete(CLAUDE_VERSION_KEYS.smokeFailure);
  if (version !== null) installation.set(CLAUDE_VERSION_KEYS.lastKnownGood, version);
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Guards new Agents against a CLI that updated itself under the Installation: a changed version gets
// one smoke query before any new Agent starts; a failed one blocks new Agents until the version
// changes again, a human asks for a recheck, or a new token passes the smoke query. Live Sessions
// are never touched.
export class ClaudeVersionGuard {
  private readonly _installation: InstallationStore;
  private readonly _driver: DriverPort;
  private readonly _clock: Clock;
  private readonly _log: Logger;
  private readonly _cwd: string;
  private _current: string | undefined;
  private _checkedAt: string | undefined;

  constructor(options: ClaudeVersionGuardOptions) {
    this._installation = options.installation;
    this._driver = options.driver;
    this._clock = options.clock;
    this._log = options.log;
    this._cwd = options.cwd;
  }

  current(): string | undefined {
    return this._current;
  }

  findLastKnownGood(): string | undefined {
    return this._installation.find(CLAUDE_VERSION_KEYS.lastKnownGood);
  }

  findFailure(): SmokeFailure | undefined {
    const raw = this._installation.find(CLAUDE_VERSION_KEYS.smokeFailure);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as SmokeFailure;
    } catch {
      this._log.warn({ key: CLAUDE_VERSION_KEYS.smokeFailure }, "installation value is not JSON, ignoring it");
      return undefined;
    }
  }

  blocked(): boolean {
    return this.findFailure() !== undefined;
  }

  view(): ClaudeVersionView {
    const failure = this.findFailure();
    const lastKnownGood = this.findLastKnownGood() ?? null;
    return {
      current: this._current ?? null,
      lastKnownGood,
      status: failure ? "failed" : "ok",
      error: failure?.error ?? null,
      rollbackCommand: failure && lastKnownGood !== null ? rollbackCommandFor(lastKnownGood) : null,
      checkedAt: this._checkedAt ?? null,
    };
  }

  markVerified(version: string | null): void {
    markClaudeVersionVerified(this._installation, version);
  }

  // Once per polling cycle, before any new Agent: the smoke query runs only when the version moved
  // away from the last known good one and has not failed already.
  async check(): Promise<ClaudeVersionView> {
    const current = await this._readVersion();
    if (current === undefined) return this.view();
    const lastKnownGood = this.findLastKnownGood();
    if (lastKnownGood === undefined) {
      // The wizard proved this Installation already; the first version seen is the baseline.
      this.markVerified(current);
      this._log.info({ claudeVersion: current }, "claude version recorded");
      return this.view();
    }
    if (current === lastKnownGood) {
      if (this.findFailure()) {
        this._installation.delete(CLAUDE_VERSION_KEYS.smokeFailure);
        this._log.info({ claudeVersion: current }, "claude rolled back to the last known good version");
      }
      return this.view();
    }
    const failure = this.findFailure();
    if (failure && failure.version === current) return this.view();
    await this._smoke(current, lastKnownGood);
    return this.view();
  }

  // A human asks for another try on the same version, e.g. after fixing the CLI by hand.
  async recheck(): Promise<ClaudeVersionView> {
    const current = await this._readVersion();
    if (current === undefined) return this.view();
    await this._smoke(current, this.findLastKnownGood());
    return this.view();
  }

  private async _readVersion(): Promise<string | undefined> {
    this._checkedAt = new Date(this._clock.now()).toISOString();
    try {
      this._current = await this._driver.getClaudeVersion();
      return this._current;
    } catch (error) {
      this._current = undefined;
      const failure = this.findFailure();
      if (!failure || failure.version !== null) this._fail(null, `claude did not report its version: ${errorText(error)}`);
      return undefined;
    }
  }

  private async _smoke(version: string, lastKnownGood: string | undefined): Promise<void> {
    this._log.info({ claudeVersion: version, lastKnownGood: lastKnownGood ?? null }, "claude version changed, running a smoke query");
    const result = await this._driver.smokeQuery({ cwd: this._cwd });
    if (result.ok) {
      this.markVerified(version);
      this._log.info({ claudeVersion: version, model: result.model }, "smoke query passed, claude version is good");
      return;
    }
    this._fail(version, result.error);
  }

  private _fail(version: string | null, error: string): void {
    const failure: SmokeFailure = { version, error, at: new Date(this._clock.now()).toISOString() };
    this._installation.set(CLAUDE_VERSION_KEYS.smokeFailure, JSON.stringify(failure));
    const lastKnownGood = this.findLastKnownGood();
    this._log.error(
      { claudeVersion: version, lastKnownGood: lastKnownGood ?? null, error, rollback: lastKnownGood ? rollbackCommandFor(lastKnownGood) : null },
      "smoke query failed, new agents are blocked",
    );
  }
}
