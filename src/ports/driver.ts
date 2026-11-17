import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Pid, SessionId, ToolUseId } from "../ids.js";

export type { SDKMessage };

export type AskHumanCall = {
  toolUseId: ToolUseId;
  question: string;
  options: string[] | undefined;
};

// What the Orchestrator tells the Agent process when it asks a human:
// `defer` ends the Turn with `tool_deferred`, `allow` resumes it with the Answer.
// `source` is the one line "who and from where" the Agent sees next to the Answer.
export type AskHumanDecision = { kind: "defer" } | { kind: "allow"; answer: string; source?: string };

export type AgentLaunch = {
  cwd: string;
  // Absent prompt means an open input stream without a message (resume after a deferred tool).
  prompt?: string;
  resume?: SessionId;
  resumeInterruptedTurn?: boolean;
  // Extra environment on top of what the adapter builds for every Agent.
  env?: Record<string, string>;
  // Model alias or id; the CLI default otherwise.
  model?: string;
  onAskHuman?: (call: AskHumanCall) => Promise<AskHumanDecision>;
};

export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

// A user message pushed into a live process. `taken` settles once the Session took it in: true when the
// CLI started on it (folded into the running Turn between tool rounds, or a Turn of its own), false when
// the process ended first and the message never reached the Session.
export type SentMessage = { taken: Promise<boolean> };

// One running Agent process. Messages are consumed once, in order.
export interface AgentProcess {
  messages(): AsyncIterable<SDKMessage>;
  // Session id becomes known with the first message from the process.
  sessionId(): SessionId | undefined;
  pid(): Pid | undefined;
  // Next user message into the live input stream; during a Turn the CLI folds it in at the next tool round.
  send(text: string): Promise<SentMessage>;
  // Some sent message is not taken by the Session yet: a result now does not end the work of the process.
  hasPendingInput(): boolean;
  interrupt(): Promise<void>;
  // interrupt() followed by SIGTERM; resolves once the process exited.
  stop(): Promise<ProcessExit>;
  exited(): Promise<ProcessExit>;
}

export type SessionHistoryOptions = {
  // Directory the Session ran in; narrows the lookup to that project.
  cwd?: string;
};

export type SmokeQueryOptions = {
  cwd: string;
  // Overrides on top of the Installation environment, e.g. a token that is not stored yet.
  env?: Record<string, string>;
};

// One short Turn without tools: proves that the CLI starts and the subscription answers.
export type SmokeQueryResult =
  | { ok: true; claudeVersion: string | null; model: string | null; text: string }
  | { ok: false; error: string };

// A model the subscription offers, as the CLI lists it: `value` goes into the launch as is.
export type ModelOption = { value: string; displayName: string; description: string };

export interface DriverPort {
  launch(launch: AgentLaunch): AgentProcess;
  smokeQuery(options: SmokeQueryOptions): Promise<SmokeQueryResult>;
  // The models of the subscription under the stored OAuth token; no Turn, no tokens spent.
  listModels(options: { cwd: string }): Promise<ModelOption[]>;
  // Transcript of a Session as user and assistant messages, oldest first.
  getSessionHistory(sessionId: SessionId, options?: SessionHistoryOptions): Promise<SDKMessage[]>;
  getClaudeVersion(): Promise<string>;
}
