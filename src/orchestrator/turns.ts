import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type Result = Extract<SDKMessage, { type: "result" }>;

// The Turn was cut short by interrupt() or a signal: whatever the Agent produced is not finished work.
const ABORTED_REASONS: ReadonlySet<string> = new Set(["aborted_streaming", "aborted_tools"]);

// Sent into a Session whose Turn was cut short or failed, to pick the work up where it stopped.
export const CONTINUE_PROMPT = "Продолжай.";

export const isResult = (message: SDKMessage): message is Result => message.type === "result";

export const isDeferred = (message: SDKMessage): boolean =>
  message.type === "result" && message.subtype === "success" && message.terminal_reason === "tool_deferred";

export const isAborted = (message: SDKMessage): boolean =>
  message.type === "result" && message.terminal_reason !== undefined && ABORTED_REASONS.has(message.terminal_reason);

// A result that ends the Turn with work to act on: not a deferred ask_human, not an interrupted Turn.
export const isTurnEnd = (message: SDKMessage): boolean => isResult(message) && !isDeferred(message) && !isAborted(message);
