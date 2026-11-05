import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Pid, SessionId } from "../ids.js";
import type {
  AgentLaunch,
  AgentProcess,
  AskHumanCall,
  AskHumanDecision,
  DriverPort,
  ProcessExit,
} from "../ports/driver.js";
import { CallLog } from "./call-log.js";

const TERMINATED: ProcessExit = { code: null, signal: "SIGTERM" };
const FINISHED: ProcessExit = { code: 0, signal: null };

// One scripted Agent process: the test emits SDK messages, the Orchestrator consumes them.
export class FakeAgentProcess implements AgentProcess {
  readonly log = new CallLog();
  readonly sent: string[] = [];
  private _sessionId: SessionId | undefined;
  private _pid: Pid | undefined;
  private readonly _queue: SDKMessage[] = [];
  private _wake: (() => void) | undefined;
  private _exit: ProcessExit | undefined;
  private _resolveExit!: (exit: ProcessExit) => void;
  private readonly _exited = new Promise<ProcessExit>((resolve) => {
    this._resolveExit = resolve;
  });

  constructor(
    readonly launch: AgentLaunch,
    pid: Pid,
  ) {
    this._pid = pid;
    this._sessionId = launch.resume;
  }

  get calls() {
    return this.log.calls;
  }

  emit(message: SDKMessage): void {
    if (this._exit) throw new Error("process already exited");
    if ("session_id" in message && typeof message.session_id === "string") {
      this._sessionId = message.session_id as SessionId;
    }
    this._queue.push(message);
    this._wake?.();
  }

  // Ends the message stream; `exit` defaults to a clean exit.
  end(exit: ProcessExit = FINISHED): void {
    if (this._exit) return;
    this._exit = exit;
    this._pid = undefined;
    this._resolveExit(exit);
    this._wake?.();
  }

  // Simulates the PreToolUse hook of `ask_human`.
  askHuman(call: AskHumanCall): Promise<AskHumanDecision> {
    if (!this.launch.onAskHuman) throw new Error("launch has no onAskHuman handler");
    return this.launch.onAskHuman(call);
  }

  async *messages(): AsyncIterable<SDKMessage> {
    for (;;) {
      const next = this._queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this._exit) return;
      await new Promise<void>((resolve) => {
        this._wake = resolve;
      });
      this._wake = undefined;
    }
  }

  sessionId(): SessionId | undefined {
    return this._sessionId;
  }

  pid(): Pid | undefined {
    return this._pid;
  }

  async send(text: string): Promise<void> {
    this.log.record("send", text);
    if (this._exit) throw new Error("process already exited");
    this.sent.push(text);
  }

  async interrupt(): Promise<void> {
    this.log.record("interrupt");
  }

  async stop(): Promise<ProcessExit> {
    this.log.record("stop");
    this.end(TERMINATED);
    return this._exited;
  }

  exited(): Promise<ProcessExit> {
    return this._exited;
  }
}

export class FakeDriverPort implements DriverPort {
  readonly log = new CallLog();
  readonly launches: FakeAgentProcess[] = [];
  readonly histories = new Map<SessionId, SDKMessage[]>();
  claudeVersion = "2.1.318";
  private _nextPid = 1000;
  private readonly _scripts: SDKMessage[][] = [];

  get calls() {
    return this.log.calls;
  }

  // Messages the next launched process emits on its own, ending the stream afterwards.
  scriptNextLaunch(messages: SDKMessage[]): void {
    this._scripts.push(messages);
  }

  lastLaunch(): FakeAgentProcess {
    const last = this.launches.at(-1);
    if (!last) throw new Error("nothing launched yet");
    return last;
  }

  launch(launch: AgentLaunch): AgentProcess {
    this.log.record("launch", launch);
    const process = new FakeAgentProcess(launch, this._nextPid++ as Pid);
    this.launches.push(process);
    const script = this._scripts.shift();
    if (script) {
      for (const message of script) process.emit(message);
      process.end();
    }
    return process;
  }

  async getSessionHistory(sessionId: SessionId): Promise<SDKMessage[]> {
    this.log.record("getSessionHistory", sessionId);
    return [...(this.histories.get(sessionId) ?? [])];
  }

  async getClaudeVersion(): Promise<string> {
    this.log.record("getClaudeVersion");
    return this.claudeVersion;
  }
}
