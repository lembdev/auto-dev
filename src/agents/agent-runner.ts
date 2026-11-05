import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentId, IssueNumber, SessionId } from "../ids.js";
import type { AgentPatch, AgentRecord, AgentRole, AgentState, AgentStore } from "../index/agents.js";
import type { Logger } from "../log.js";
import type { Clock, TimerHandle } from "../ports/clock.js";
import type { AgentLaunch, AgentProcess, AskHumanCall, AskHumanDecision, DriverPort } from "../ports/driver.js";

// How long a process stays alive after a Turn before the runner stops it; the Session survives.
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export type AgentRunnerDeps = {
  driver: DriverPort;
  clock: Clock;
  agents: AgentStore;
  log: Logger;
  idleTimeoutMs?: number;
};

// Per-launch settings that the Driver needs again when the runner resumes the Session itself.
export type AgentSessionOptions = {
  env?: Record<string, string>;
  onAskHuman?: (call: AskHumanCall) => Promise<AskHumanDecision>;
};

export type StartAgent = AgentSessionOptions & {
  issueNumber?: IssueNumber;
  role: AgentRole;
  cwd: string;
  prompt: string;
};

export type ResumeAgent = AgentSessionOptions & {
  // Absent prompt keeps the input stream open without a message: the way to deliver an Answer.
  prompt?: string;
  resumeInterruptedTurn?: boolean;
};

export type MessageListener = (agent: AgentRecord, message: SDKMessage) => void;
export type StateListener = (agent: AgentRecord, previous: AgentState) => void;

export class AgentAlreadyRunningError extends Error {
  constructor(readonly id: AgentId) {
    super(`agent ${id} already has a live process`);
    this.name = "AgentAlreadyRunningError";
  }
}

export class AgentNotResumableError extends Error {
  constructor(
    readonly id: AgentId,
    reason: string,
  ) {
    super(`agent ${id} cannot be resumed: ${reason}`);
    this.name = "AgentNotResumableError";
  }
}

type Live = {
  process: AgentProcess;
  options: AgentSessionOptions;
  idleTimer: TimerHandle | undefined;
  finished: Promise<void>;
};

const isDeferred = (message: SDKMessage): boolean =>
  message.type === "result" && message.subtype === "success" && message.terminal_reason === "tool_deferred";

// Drives Agent processes through the Driver and keeps the `agents` table true to what they do:
// running during a Turn, idle after it until the timeout, waiting after a deferred ask_human,
// stopped once the process is gone. Messages and state changes fan out to listeners.
export class AgentRunner {
  private readonly _live = new Map<AgentId, Live>();
  private readonly _options = new Map<AgentId, AgentSessionOptions>();
  private readonly _messageListeners = new Set<MessageListener>();
  private readonly _stateListeners = new Set<StateListener>();
  private readonly _idleTimeoutMs: number;

  constructor(private readonly _deps: AgentRunnerDeps) {
    this._idleTimeoutMs = _deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  onMessage(listener: MessageListener): () => void {
    this._messageListeners.add(listener);
    return () => this._messageListeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this._stateListeners.add(listener);
    return () => this._stateListeners.delete(listener);
  }

  find(id: AgentId): AgentRecord | undefined {
    return this._deps.agents.find(id);
  }

  isLive(id: AgentId): boolean {
    return this._live.has(id);
  }

  liveIds(): AgentId[] {
    return [...this._live.keys()];
  }

  // New Session: creates the `agents` row and launches the process with the Stage prompt.
  start(spec: StartAgent): AgentRecord {
    const record = this._deps.agents.create({
      ...(spec.issueNumber !== undefined ? { issueNumber: spec.issueNumber } : {}),
      role: spec.role,
      cwd: spec.cwd,
      createdAt: this._iso(),
    });
    const options = sessionOptions(spec);
    return this._launch(record, { cwd: record.cwd, prompt: spec.prompt, ...launchOptions(options) }, options);
  }

  // Existing Session: a fresh process continues it, with or without a new message.
  resume(id: AgentId, spec: ResumeAgent = {}): AgentRecord {
    const record = this._deps.agents.get(id);
    if (this._live.has(id)) throw new AgentAlreadyRunningError(id);
    if (!record.sessionId) throw new AgentNotResumableError(id, "no session id recorded");
    const options = sessionOptions(spec, this._options.get(id));
    return this._launch(
      record,
      {
        cwd: record.cwd,
        resume: record.sessionId,
        ...(spec.prompt !== undefined ? { prompt: spec.prompt } : {}),
        ...(spec.resumeInterruptedTurn ? { resumeInterruptedTurn: true } : {}),
        ...launchOptions(options),
      },
      options,
    );
  }

  // Next message of the Dialogue; a stopped Agent gets its Session resumed with the text as the prompt.
  async send(id: AgentId, text: string): Promise<void> {
    const live = this._live.get(id);
    if (!live) {
      const record = this._deps.agents.get(id);
      if (record.state === "waiting") throw new AgentNotResumableError(id, "waiting for an Answer; resume it with onAskHuman");
      this.resume(id, { prompt: text });
      return;
    }
    this._clearIdleTimer(live);
    this._setState(id, { state: "running" });
    await live.process.send(text);
  }

  async interrupt(id: AgentId): Promise<void> {
    await this._live.get(id)?.process.interrupt();
  }

  // Interrupts the Turn and terminates the process; the row ends up stopped (or waiting).
  async stop(id: AgentId): Promise<void> {
    const live = this._live.get(id);
    if (!live) return;
    this._clearIdleTimer(live);
    await live.process.stop();
    await live.finished;
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.liveIds().map((id) => this.stop(id)));
  }

  private _launch(record: AgentRecord, launch: AgentLaunch, options: AgentSessionOptions): AgentRecord {
    const process = this._deps.driver.launch(launch);
    this._options.set(record.id, options);
    const live: Live = { process, options, idleTimer: undefined, finished: Promise.resolve() };
    this._live.set(record.id, live);
    const started = this._setState(record.id, { state: "running", pid: process.pid() ?? null, sessionId: process.sessionId() ?? record.sessionId });
    this._deps.log.info({ agent: record.id, issue: record.issueNumber, role: record.role, pid: started.pid, resume: launch.resume }, "agent process started");
    live.finished = this._pump(record.id, live);
    return started;
  }

  private async _pump(id: AgentId, live: Live): Promise<void> {
    try {
      for await (const message of live.process.messages()) {
        this._observe(id, live, message);
        const current = this._deps.agents.get(id);
        for (const listener of this._messageListeners) listener(current, message);
      }
    } catch (error) {
      this._deps.log.error({ err: error, agent: id }, "agent message stream failed");
    }
    const exit = await live.process.exited();
    this._clearIdleTimer(live);
    this._live.delete(id);
    const record = this._deps.agents.get(id);
    this._setState(id, { pid: null, ...(record.state === "waiting" ? {} : { state: "stopped" }) });
    this._deps.log.info({ agent: id, ...exit }, "agent process exited");
  }

  private _observe(id: AgentId, live: Live, message: SDKMessage): void {
    const patch: AgentPatch = {};
    const sessionId = "session_id" in message && typeof message.session_id === "string" ? (message.session_id as SessionId) : undefined;
    if (sessionId) patch.sessionId = sessionId;
    const pid = live.process.pid();
    if (pid !== undefined) patch.pid = pid;
    if (message.type === "result") {
      patch.lastTurnAt = this._iso();
      if (isDeferred(message)) {
        patch.state = "waiting";
      } else {
        patch.state = "idle";
        this._armIdleTimer(id, live);
      }
    }
    this._setState(id, patch);
  }

  private _armIdleTimer(id: AgentId, live: Live): void {
    this._clearIdleTimer(live);
    live.idleTimer = this._deps.clock.setTimeout(() => {
      live.idleTimer = undefined;
      this._deps.log.info({ agent: id }, "idle timeout, stopping the process");
      live.process.stop().catch((error: unknown) => this._deps.log.error({ err: error, agent: id }, "idle stop failed"));
    }, this._idleTimeoutMs);
  }

  private _clearIdleTimer(live: Live): void {
    if (live.idleTimer === undefined) return;
    this._deps.clock.clear(live.idleTimer);
    live.idleTimer = undefined;
  }

  private _setState(id: AgentId, patch: AgentPatch): AgentRecord {
    const before = this._deps.agents.get(id);
    const after = this._deps.agents.update(id, patch);
    if (after.state !== before.state) {
      for (const listener of this._stateListeners) listener(after, before.state);
    }
    return after;
  }

  private _iso(): string {
    return new Date(this._deps.clock.now()).toISOString();
  }
}

const sessionOptions = (spec: AgentSessionOptions, remembered: AgentSessionOptions = {}): AgentSessionOptions => ({
  ...(spec.env ?? remembered.env ? { env: spec.env ?? remembered.env } : {}),
  ...(spec.onAskHuman ?? remembered.onAskHuman ? { onAskHuman: spec.onAskHuman ?? remembered.onAskHuman } : {}),
});

const launchOptions = (options: AgentSessionOptions): Pick<AgentLaunch, "env" | "onAskHuman"> => ({
  ...(options.env ? { env: options.env } : {}),
  ...(options.onAskHuman ? { onAskHuman: options.onAskHuman } : {}),
});
