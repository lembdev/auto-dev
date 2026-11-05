import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Pid, SessionId } from "../ids.js";

export type { SDKMessage };

export type AskHumanCall = {
  toolUseId: string;
  question: string;
  options: string[] | undefined;
};

// What the Orchestrator tells the Agent process when it asks a human:
// `defer` ends the Turn with `tool_deferred`, `allow` resumes it with the Answer.
export type AskHumanDecision = { kind: "defer" } | { kind: "allow"; answer: string };

export type AgentLaunch = {
  cwd: string;
  // Absent prompt means an open input stream without a message (resume after a deferred tool).
  prompt?: string;
  resume?: SessionId;
  resumeInterruptedTurn?: boolean;
  // Extra environment on top of what the adapter builds for every Agent.
  env?: Record<string, string>;
  onAskHuman?: (call: AskHumanCall) => Promise<AskHumanDecision>;
};

export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

// One running Agent process. Messages are consumed once, in order.
export interface AgentProcess {
  messages(): AsyncIterable<SDKMessage>;
  // Session id becomes known with the first message from the process.
  sessionId(): SessionId | undefined;
  pid(): Pid | undefined;
  // Next user message into the live input stream.
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  // interrupt() followed by SIGTERM; resolves once the process exited.
  stop(): Promise<ProcessExit>;
  exited(): Promise<ProcessExit>;
}

export interface DriverPort {
  launch(launch: AgentLaunch): AgentProcess;
  getSessionHistory(sessionId: SessionId): Promise<SDKMessage[]>;
  getClaudeVersion(): Promise<string>;
}
