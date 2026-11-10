import type { AgentRunner } from "../agents/agent-runner.js";
import type { AgentId, IssueNumber } from "../ids.js";
import type { AgentRole } from "../index/agents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { InstallationState } from "./installation-state.js";
import type { Recovery } from "./recovery.js";

export const RESTART_PAUSE_REASON = "preparing for a restart";
// Key in the `installation` table: when the human asked to prepare a restart.
export const RESTART_KEY = "restart.since";

export type DrainingTurn = { agentId: AgentId; issueNumber: IssueNumber | null; role: AgentRole };

export type RestartView = {
  // A human asked to prepare the Installation for a restart and has not cancelled it.
  active: boolean;
  since: string | null;
  // Turns still under way; the restart is safe once the list is empty.
  running: DrainingTurn[];
  ready: boolean;
  // The Pause is this module's own and the next start lifts it; false when a human Pause was already on.
  liftsPause: boolean;
};

export type RestartDrainOptions = {
  index: RuntimeIndex;
  clock: Clock;
  installation: InstallationState;
  runner: AgentRunner;
  recovery: Recovery;
  log: Logger;
};

// Preparing a restart by hand: a Pause stops new Tasks, Rounds and Turns, the running Turns finish,
// and the Installation says when nothing runs. Every Stage then sits on a boundary the Runtime index
// already holds. The next start lifts the Pause this module set; a Pause of another source stays.
export class RestartDrain {
  private readonly _index: RuntimeIndex;
  private readonly _clock: Clock;
  private readonly _installation: InstallationState;
  private readonly _runner: AgentRunner;
  private readonly _recovery: Recovery;
  private readonly _log: Logger;
  private _started = false;

  constructor(options: RestartDrainOptions) {
    this._index = options.index;
    this._clock = options.clock;
    this._installation = options.installation;
    this._runner = options.runner;
    this._recovery = options.recovery;
    this._log = options.log;
  }

  // The process (re)started: the restart it was prepared for has happened.
  start(): void {
    if (this._started) return;
    this._started = true;
    const since = this._since();
    if (since === undefined) return;
    this._finish();
    this._log.info({ since }, "restart finished");
  }

  begin(): RestartView {
    // Set in this process, so it is not a leftover of the previous run for `start` to clear.
    this._started = true;
    if (this.active()) return this.view();
    if (!this._installation.paused()) this._installation.pause("restart", RESTART_PAUSE_REASON);
    this._index.installation.set(RESTART_KEY, new Date(this._clock.now()).toISOString());
    this._log.info({ running: this._running().length }, "preparing for a restart");
    return this.view();
  }

  cancel(): RestartView {
    if (this._since() === undefined) return this.view();
    this._finish();
    this._log.info("restart preparation cancelled");
    return this.view();
  }

  // The human does not want to wait for the long Turns: they are cut short and continue in their
  // Sessions after the restart, exactly as an update does it.
  async interruptRunning(): Promise<RestartView> {
    if (!this.active()) return this.view();
    const running = this._running();
    if (running.length === 0) return this.view();
    this._recovery.rememberRunning();
    this._log.warn({ agents: running.map((turn) => turn.agentId) }, "interrupting the running turns before a restart");
    await Promise.all(
      running.map((turn) =>
        this._runner.interrupt(turn.agentId).catch((error: unknown) => this._log.error({ err: error, agent: turn.agentId }, "interrupt before a restart failed")),
      ),
    );
    return this.view();
  }

  // A human who lifted the Pause by hand has given up the restart as well.
  active(): boolean {
    return this._since() !== undefined && this._installation.paused();
  }

  view(): RestartView {
    const since = this._since();
    if (since === undefined || !this._installation.paused()) return { active: false, since: null, running: [], ready: false, liftsPause: false };
    const running = this._running();
    return { active: true, since, running, ready: running.length === 0, liftsPause: this._installation.findPause()?.source === "restart" };
  }

  private _since(): string | undefined {
    return this._index.installation.find(RESTART_KEY);
  }

  private _finish(): void {
    this._index.installation.delete(RESTART_KEY);
    if (this._installation.findPause()?.source === "restart") this._installation.unpause();
  }

  private _running(): DrainingTurn[] {
    const turns: DrainingTurn[] = [];
    for (const id of this._runner.liveIds()) {
      const agent = this._runner.find(id);
      if (agent?.state === "running") turns.push({ agentId: id, issueNumber: agent.issueNumber, role: agent.role });
    }
    return turns;
  }
}
