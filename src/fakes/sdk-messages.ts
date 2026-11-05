import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { SessionId } from "../ids.js";

type Init = Extract<SDKMessage, { type: "system"; subtype: "init" }>;
type Assistant = Extract<SDKMessage, { type: "assistant" }>;
type ResultSuccess = Extract<SDKMessage, { type: "result"; subtype: "success" }>;
type ResultError = Extract<SDKMessage, { type: "result"; errors: string[] }>;
type RateLimitEvent = Extract<SDKMessage, { type: "rate_limit_event" }>;
type ApiRetry = Extract<SDKMessage, { type: "system"; subtype: "api_retry" }>;

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
    return {
      type: "assistant",
      message: {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text, citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        usage: { input_tokens: 0, output_tokens: 0 } as unknown as Assistant["message"]["usage"],
      },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
      ...overrides,
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
