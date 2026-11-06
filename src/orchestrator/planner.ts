import { RESTART_PROMPT } from "./turns.js";
import type { AgentRunner } from "../agents/agent-runner.js";
import type { AgentId, PlannerLineId, SessionId } from "../ids.js";
import type { AgentRecord } from "../index/agents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { WorktreePort } from "../ports/worktree.js";
import { StagePrompts } from "../prompts/index.js";
import type { Ack, AckOutcome } from "./dialogue.js";
import type { StartBlocker } from "./installation-state.js";
import type { UiFrameIdentity } from "./human-requests.js";

// Keys in the `installation` table.
export const PLANNER_KEYS = {
  // Session id of the last Planner; "resume" continues it.
  lastSession: "planner.last_session",
} as const;

export const PLANNER_MODES = ["resume", "new"] as const;
export type PlannerMode = (typeof PLANNER_MODES)[number];

// The first message of a resumed Session when the human gave none.
export const RESUME_PROMPT = "Продолжаем планирование. Кратко напомни, на чём остановились, и жди моих указаний.";

export type PlannerStatus = "none" | "running" | "idle" | "stopped";

export type StartPlanner = { mode: PlannerMode; message?: string };

// A frame of the Dialogue with the Planner; the same sender identity as the Dialogue frames.
export type PlannerFrame = UiFrameIdentity & { type: "planner"; text: string };

export type { PlannerLineId };

// A line typed while the Planner runs a Turn: it waits in memory for the end of the Turn.
export type PlannerLine = UiFrameIdentity & { id: PlannerLineId; text: string; createdAt: string };

export type RemovePlannerLineOutcome = "removed" | "not-found";

export type PlannerSnapshot = {
  status: PlannerStatus;
  // True between start and finish: the Dialogue is open and a line to a stopped process resumes the Session.
  open: boolean;
  // The Agent of the open Session, else of the last one.
  agent: AgentRecord | undefined;
  queue: PlannerLine[];
};

export class PlannerBusyError extends Error {
  constructor(readonly agentId: AgentId) {
    super(`the Planner is already running as agent ${agentId}`);
    this.name = "PlannerBusyError";
  }
}

export class PlannerSessionNotFoundError extends Error {
  constructor() {
    super("there is no previous planning Session to resume");
    this.name = "PlannerSessionNotFoundError";
  }
}

// New Turns are on hold (Pause, the limit, the pre-arm, a blocked CLI version): the Planner does not start.
export class PlannerOnHoldError extends Error {
  constructor(readonly blocker: StartBlocker) {
    super(`the Planner cannot start a Turn now: ${blocker}`);
    this.name = "PlannerOnHoldError";
  }
}

export class ProductNotClonedError extends Error {
  constructor(readonly repoPath: string) {
    super(`the Product is not cloned at ${repoPath}`);
    this.name = "ProductNotClonedError";
  }
}

export type PlannerOptions = {
  index: RuntimeIndex;
  runner: AgentRunner;
  worktree: WorktreePort;
  log: Logger;
  clock: Clock;
  prompts?: StagePrompts;
  repoPath: string;
  baseBranch: string;
  // What keeps new Turns from starting, if anything; lines wait for `deliver()` on the next cycle.
  startBlocker?: () => StartBlocker | undefined;
};

// The Planner: one Session of Claude Code on the clone of the Product, outside Tasks and Slots, that
// turns the human's intent into milestones and issues. The human talks to it in the Dialogue of the
// planning mode; lines typed during a Turn queue up and go in one per Turn. The Session survives
// "finish" and a restart; the next entry into the mode may resume it.
export class Planner {
  private readonly _index: RuntimeIndex;
  private readonly _runner: AgentRunner;
  private readonly _worktree: WorktreePort;
  private readonly _log: Logger;
  private readonly _clock: Clock;
  private readonly _prompts: StagePrompts;
  private readonly _repoPath: string;
  private readonly _baseBranch: string;
  private readonly _queue: PlannerLine[] = [];
  private readonly _changeListeners = new Set<() => void>();
  private _openAgentId: AgentId | undefined;
  private _nextLineId = 1;
  private _delivering = false;
  private readonly _startBlocker: () => StartBlocker | undefined;

  constructor(options: PlannerOptions) {
    this._index = options.index;
    this._runner = options.runner;
    this._worktree = options.worktree;
    this._log = options.log;
    this._clock = options.clock;
    this._prompts = options.prompts ?? new StagePrompts();
    this._repoPath = options.repoPath;
    this._baseBranch = options.baseBranch;
    this._startBlocker = options.startBlocker ?? (() => undefined);
    this._runner.onMessage((agent) => {
      if (agent.role !== "planner" || agent.sessionId === null) return;
      if (this._index.installation.find(PLANNER_KEYS.lastSession) !== agent.sessionId) {
        this._index.installation.set(PLANNER_KEYS.lastSession, agent.sessionId);
      }
    });
    // The end of a Turn is the moment for the next line; listeners of the message run after this one.
    this._runner.onStateChange((agent) => {
      if (agent.role !== "planner") return;
      this._notify();
      if (agent.id === this._openAgentId) void Promise.resolve().then(() => this.deliver());
    });
  }

  onChange(listener: () => void): () => void {
    this._changeListeners.add(listener);
    return () => this._changeListeners.delete(listener);
  }

  snapshot(): PlannerSnapshot {
    const agent = this.current() ?? this.findPreviousSession();
    return { status: this._statusOf(agent), open: this._openAgentId !== undefined, agent, queue: this.list() };
  }

  // The Agent of the open Session: between start and finish, with or without a live process.
  current(): AgentRecord | undefined {
    return this._openAgentId === undefined ? undefined : this._index.agents.find(this._openAgentId);
  }

  // The last Planner Session: by the remembered session id, else the newest planner Agent that has one.
  findPreviousSession(): AgentRecord | undefined {
    const remembered = this._index.installation.find(PLANNER_KEYS.lastSession) as SessionId | undefined;
    const bySession = remembered === undefined ? undefined : this._index.agents.findBySession(remembered);
    if (bySession) return bySession;
    return this._index.agents
      .list()
      .filter((agent) => agent.role === "planner" && agent.sessionId !== null)
      .at(-1);
  }

  // A new Session with the `plan` prompt, or the previous one resumed; the clone is put on the base
  // branch first. One Planner at a time.
  async start(spec: StartPlanner): Promise<AgentRecord> {
    const live = this._liveAgent();
    if (live) throw new PlannerBusyError(live.id);
    const previous = spec.mode === "resume" ? this.findPreviousSession() : undefined;
    if (spec.mode === "resume" && !previous) throw new PlannerSessionNotFoundError();
    const blocker = this._startBlocker();
    if (blocker !== undefined) throw new PlannerOnHoldError(blocker);
    await this._prepareClone();
    const message = spec.message?.trim() ?? "";
    let agent: AgentRecord;
    if (previous) {
      agent = this._runner.resume(previous.id, { prompt: message === "" ? RESUME_PROMPT : message });
      this._log.info({ agent: agent.id, session: previous.sessionId }, "planner session resumed");
    } else {
      const prompt = this._prompts.renderPlan({ repoPath: this._repoPath, baseBranch: this._baseBranch });
      agent = this._runner.start({
        role: "planner",
        cwd: this._repoPath,
        prompt: message === "" ? prompt : `${prompt}\n## Первое сообщение человека\n\n${message}\n`,
      });
      this._log.info({ agent: agent.id, cwd: this._repoPath }, "planner started");
    }
    this._openAgentId = agent.id;
    this._notify();
    return agent;
  }

  // A Turn cut short by a restart: the same Session continues and is the open one again. False when the
  // human has opened another Session meanwhile; there is only ever one Planner.
  resumeInterrupted(agent: AgentRecord): boolean {
    if (this._openAgentId !== undefined && this._openAgentId !== agent.id) return false;
    if (this._liveAgent()) return false;
    this._runner.resume(agent.id, { prompt: RESTART_PROMPT });
    this._openAgentId = agent.id;
    this._notify();
    return true;
  }

  // The human is done for now: the process goes, the Session stays for the next "resume".
  async finish(): Promise<AgentRecord | undefined> {
    const agent = this.current();
    this._openAgentId = undefined;
    const dropped = this._queue.splice(0);
    if (dropped.length > 0) this._log.warn({ dropped: dropped.length }, "planner lines dropped: planning finished");
    if (agent && this._runner.isLive(agent.id)) {
      await this._runner.stop(agent.id);
      this._log.info({ agent: agent.id, session: agent.sessionId }, "planner stopped; the session is kept");
    }
    this._notify();
    return agent ? this._index.agents.get(agent.id) : undefined;
  }

  async interrupt(): Promise<AgentRecord | undefined> {
    const agent = this._liveAgent();
    if (!agent || agent.state !== "running") return undefined;
    await this._runner.interrupt(agent.id);
    this._log.info({ agent: agent.id }, "planner turn interrupted from the UI");
    return this._index.agents.get(agent.id);
  }

  // One frame of the Dialogue: queued once, seen before or refused for good. The watermark is the one
  // the Dialogue keeps per client, so a tab's sequence counts once across both.
  receive(frame: PlannerFrame): Ack {
    const watermark = this._index.dialogue.watermark(frame.clientId);
    if (frame.seq <= watermark) return this._ack(frame, "duplicate", null);
    if (frame.text.trim() === "") return this._reject(frame, "empty text");
    if (this._openAgentId === undefined) return this._reject(frame, "the Planner is not started");
    this._index.dialogue.advance(frame.clientId, frame.seq);
    const line: PlannerLine = { id: this._nextLineId++ as PlannerLineId, clientId: frame.clientId, seq: frame.seq, text: frame.text.trim(), createdAt: this._iso() };
    this._queue.push(line);
    this._log.info({ client: frame.clientId, seq: frame.seq, line: line.id }, "planner line queued");
    this._notify();
    void this.deliver();
    return this._ack(frame, "applied", null);
  }

  // Lines not yet in the Session, oldest first.
  list(): PlannerLine[] {
    return this._queue.map((line) => ({ ...line }));
  }

  remove(id: PlannerLineId): RemovePlannerLineOutcome {
    const index = this._queue.findIndex((line) => line.id === id);
    if (index < 0) return "not-found";
    this._queue.splice(index, 1);
    this._log.info({ line: id }, "planner line removed");
    this._notify();
    return "removed";
  }

  // The oldest line goes into the Session once the Planner is between Turns and new Turns may start; a stopped process is
  // resumed with the line as its prompt.
  async deliver(): Promise<void> {
    if (this._delivering) return;
    const agent = this.current();
    const line = this._queue[0];
    if (!agent || !line || agent.state === "running" || agent.state === "waiting") return;
    // Every line starts a Turn; while Turns are on hold the queue waits for the next cycle.
    if (this._startBlocker() !== undefined) return;
    this._delivering = true;
    try {
      await this._runner.send(agent.id, line.text);
      this._queue.shift();
      this._log.info({ agent: agent.id, line: line.id }, "planner line delivered");
      this._notify();
    } catch (error) {
      this._log.error({ err: error, agent: agent.id, line: line.id }, "planner line not delivered");
    } finally {
      this._delivering = false;
    }
    if (this._queue.length > 0) void Promise.resolve().then(() => this.deliver());
  }

  // Internals

  private async _prepareClone(): Promise<void> {
    if (!(await this._worktree.isRepository(this._repoPath))) throw new ProductNotClonedError(this._repoPath);
    await this._worktree.fetch({ repoPath: this._repoPath });
    await this._worktree.checkout({ repoPath: this._repoPath, branch: this._baseBranch, base: `origin/${this._baseBranch}` });
  }

  private _liveAgent(): AgentRecord | undefined {
    const agent = this.current();
    return agent && this._runner.isLive(agent.id) ? agent : undefined;
  }

  private _statusOf(agent: AgentRecord | undefined): PlannerStatus {
    if (!agent) return "none";
    if (!this._runner.isLive(agent.id)) return "stopped";
    return agent.state === "running" ? "running" : agent.state === "idle" ? "idle" : "stopped";
  }

  private _reject(frame: UiFrameIdentity, reason: string): Ack {
    this._index.dialogue.advance(frame.clientId, frame.seq);
    this._log.warn({ client: frame.clientId, seq: frame.seq, reason }, "planner frame rejected");
    return this._ack(frame, "rejected", reason);
  }

  private _ack(frame: UiFrameIdentity, outcome: AckOutcome, reason: string | null): Ack {
    return { clientId: frame.clientId, seq: frame.seq, watermark: this._index.dialogue.watermark(frame.clientId), outcome, reason };
  }

  private _notify(): void {
    for (const listener of this._changeListeners) listener();
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}
