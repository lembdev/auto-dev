import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { SessionId } from "../ids.js";

type Init = Extract<SDKMessage, { type: "system"; subtype: "init" }>;
type Assistant = Extract<SDKMessage, { type: "assistant" }>;
type ResultSuccess = Extract<SDKMessage, { type: "result"; subtype: "success" }>;
type ResultError = Extract<SDKMessage, { type: "result"; errors: string[] }>;
type RateLimitEvent = Extract<SDKMessage, { type: "rate_limit_event" }>;
type ApiRetry = Extract<SDKMessage, { type: "system"; subtype: "api_retry" }>;
type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>;
type User = SDKUserMessage;
type CompactBoundary = Extract<SDKMessage, { type: "system"; subtype: "compact_boundary" }>;
type TaskStarted = Extract<SDKMessage, { type: "system"; subtype: "task_started" }>;
type ContentBlock = Assistant["message"]["content"][number];

// Streaming deltas are typed loosely in the SDK; the builders assemble them from plain objects.
type StreamPayload = Record<string, unknown>;

type Uuid = Init["uuid"];

const uuid = (): Uuid => randomUUID() as Uuid;

// Token accounting is irrelevant to the Orchestrator, so only the two counters are filled.
const emptyUsage = (): ResultSuccess["usage"] =>
  ({ input_tokens: 0, output_tokens: 0 }) as unknown as ResultSuccess["usage"];

// Builders for the SDK messages scenario tests feed into the fake Driver.
export const sdkMessages = {
  init(sessionId: SessionId, overrides: Partial<Init> = {}): Init {
    return {
      type: "system",
      subtype: "init",
      apiKeySource: "oauth",
      claude_code_version: "2.1.318",
      cwd: "/tmp",
      tools: [],
      mcp_servers: [],
      model: "claude-sonnet-4-5",
      permissionMode: "bypassPermissions",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: uuid(),
      session_id: sessionId,
      ...overrides,
    };
  },

  assistantText(sessionId: SessionId, text: string, overrides: Partial<Assistant> = {}): Assistant {
    return sdkMessages.assistant(sessionId, [{ type: "text", text, citations: null }], overrides);
  },

  assistantThinking(sessionId: SessionId, thinking: string, overrides: Partial<Assistant> = {}): Assistant {
    return sdkMessages.assistant(sessionId, [{ type: "thinking", thinking, signature: "sig" }], { ...overrides, message: { ...overrides.message, stop_reason: null } as Assistant["message"] });
  },

  assistantToolUse(sessionId: SessionId, id: string, name: string, input: Record<string, unknown>, overrides: Partial<Assistant> = {}): Assistant {
    return sdkMessages.assistant(sessionId, [{ type: "tool_use", id, name, input }], overrides);
  },

  // One complete assistant message with the given content blocks; `overrides.message` patches the
  // API message (its id above all), the rest patches the envelope.
  assistant(sessionId: SessionId, content: ContentBlock[], overrides: Partial<Assistant> = {}): Assistant {
    const { message, ...envelope } = overrides;
    return {
      type: "assistant",
      message: {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content,
        stop_reason: "end_turn",
        stop_sequence: null,
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        usage: { input_tokens: 0, output_tokens: 0 } as unknown as Assistant["message"]["usage"],
        ...message,
      },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
      ...envelope,
    };
  },

  // The user side of the transcript: a prompt (string) or the result of a tool call.
  userText(sessionId: SessionId, text: string, overrides: Partial<User> = {}): User {
    return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: uuid(), session_id: sessionId, ...overrides };
  },

  toolResult(sessionId: SessionId, toolUseId: string, content: string, overrides: Partial<User> & { isError?: boolean } = {}): User {
    const { isError, ...envelope } = overrides;
    return {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
      ...envelope,
    };
  },

  // Streaming events of one API message: `messageStart` opens it, blocks stream by index.
  streamEvent(sessionId: SessionId, event: StreamPayload, parentToolUseId: string | null = null): StreamEvent {
    return { type: "stream_event", event: event as unknown as StreamEvent["event"], parent_tool_use_id: parentToolUseId, uuid: uuid(), session_id: sessionId };
  },

  messageStart(sessionId: SessionId, messageId: string, parentToolUseId: string | null = null): StreamEvent {
    return sdkMessages.streamEvent(
      sessionId,
      { type: "message_start", message: { id: messageId, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } },
      parentToolUseId,
    );
  },

  contentBlockStart(sessionId: SessionId, index: number, block: StreamPayload, parentToolUseId: string | null = null): StreamEvent {
    return sdkMessages.streamEvent(sessionId, { type: "content_block_start", index, content_block: block }, parentToolUseId);
  },

  textDelta(sessionId: SessionId, index: number, text: string, parentToolUseId: string | null = null): StreamEvent {
    return sdkMessages.streamEvent(sessionId, { type: "content_block_delta", index, delta: { type: "text_delta", text } }, parentToolUseId);
  },

  thinkingDelta(sessionId: SessionId, index: number, thinking: string, parentToolUseId: string | null = null): StreamEvent {
    return sdkMessages.streamEvent(sessionId, { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } }, parentToolUseId);
  },

  inputJsonDelta(sessionId: SessionId, index: number, partialJson: string, parentToolUseId: string | null = null): StreamEvent {
    return sdkMessages.streamEvent(sessionId, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } }, parentToolUseId);
  },

  contentBlockStop(sessionId: SessionId, index: number, parentToolUseId: string | null = null): StreamEvent {
    return sdkMessages.streamEvent(sessionId, { type: "content_block_stop", index }, parentToolUseId);
  },

  messageStop(sessionId: SessionId, parentToolUseId: string | null = null): StreamEvent {
    return sdkMessages.streamEvent(sessionId, { type: "message_stop" }, parentToolUseId);
  },

  compactBoundary(sessionId: SessionId, metadata: Partial<CompactBoundary["compact_metadata"]> = {}): CompactBoundary {
    return {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 20_000, ...metadata },
      uuid: uuid(),
      session_id: sessionId,
    };
  },

  taskStarted(sessionId: SessionId, toolUseId: string, description: string, subagentType = "Explore"): TaskStarted {
    return {
      type: "system",
      subtype: "task_started",
      task_id: `task_${toolUseId}`,
      tool_use_id: toolUseId,
      description,
      subagent_type: subagentType,
      uuid: uuid(),
      session_id: sessionId,
    };
  },

  resultSuccess(sessionId: SessionId, result: string, overrides: Partial<ResultSuccess> = {}): ResultSuccess {
    return {
      type: "result",
      subtype: "success",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 1,
      result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: emptyUsage(),
      modelUsage: {},
      permission_denials: [],
      uuid: uuid(),
      session_id: sessionId,
      ...overrides,
    };
  },

  resultError(sessionId: SessionId, errors: string[], overrides: Partial<ResultError> = {}): ResultError {
    return {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: emptyUsage(),
      modelUsage: {},
      permission_denials: [],
      errors,
      uuid: uuid(),
      session_id: sessionId,
      ...overrides,
    };
  },

  rateLimitEvent(sessionId: SessionId, info: RateLimitEvent["rate_limit_info"]): RateLimitEvent {
    return { type: "rate_limit_event", rate_limit_info: info, uuid: uuid(), session_id: sessionId };
  },

  apiRetry(sessionId: SessionId, error: ApiRetry["error"], overrides: Partial<ApiRetry> = {}): ApiRetry {
    return {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1000,
      error_status: 401,
      error,
      uuid: uuid(),
      session_id: sessionId,
      ...overrides,
    };
  },
};
