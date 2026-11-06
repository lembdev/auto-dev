import { describe, expect, it } from "vitest";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { SessionId } from "../../src/ids.js";
import { applyMessage, applyMessages, childrenOf, emptyFeed, toolHead, topLevelOf, type ToolItem } from "./feed.js";

const S = "11111111-1111-4111-8111-111111111111" as SessionId;

describe("the feed built from SDK messages", () => {
  it("streams text delta by delta and keeps one row once the complete message arrives", () => {
    let feed = applyMessages(emptyFeed(), [
      sdkMessages.messageStart(S, "msg_1"),
      sdkMessages.contentBlockStart(S, 0, { type: "text", text: "" }),
      sdkMessages.textDelta(S, 0, "Reading "),
      sdkMessages.textDelta(S, 0, "the issue."),
    ]);
    expect(feed.items).toEqual([{ kind: "text", id: "msg_1:0", parent: null, text: "Reading the issue.", streaming: true }]);

    feed = applyMessages(feed, [
      sdkMessages.contentBlockStop(S, 0),
      sdkMessages.assistantText(S, "Reading the issue.", { message: { id: "msg_1" } as never }),
      sdkMessages.messageStop(S),
    ]);
    expect(feed.items.map((item) => [item.kind, (item as { text?: string }).text, (item as { streaming?: boolean }).streaming])).toEqual([["text", "Reading the issue.", false]]);
  });

  it("links a tool call with its result by id and shows the head of the input", () => {
    const feed = applyMessages(emptyFeed(), [
      sdkMessages.assistantToolUse(S, "toolu_1", "Bash", { command: "npm test\n--silent" }),
      sdkMessages.toolResult(S, "toolu_1", "12 passed"),
    ]);
    const tool = feed.items[0] as ToolItem;
    expect(tool).toMatchObject({ kind: "tool", id: "toolu_1", name: "Bash", input: { command: "npm test\n--silent" }, result: "12 passed", isError: false });
    expect(toolHead(tool.input)).toBe("npm test");
    expect(feed.items).toHaveLength(1);
  });

  it("builds the tool input from streamed JSON and marks a failed result", () => {
    const feed = applyMessages(emptyFeed(), [
      sdkMessages.messageStart(S, "msg_2"),
      sdkMessages.contentBlockStart(S, 0, { type: "tool_use", id: "toolu_2", name: "Read", input: {} }),
      sdkMessages.inputJsonDelta(S, 0, '{"file_path": "src/'),
      sdkMessages.inputJsonDelta(S, 0, 'a.ts"}'),
      sdkMessages.contentBlockStop(S, 0),
      sdkMessages.assistantToolUse(S, "toolu_2", "Read", { file_path: "src/a.ts" }, { message: { id: "msg_2" } as never }),
      sdkMessages.toolResult(S, "toolu_2", "ENOENT", { isError: true }),
    ]);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ kind: "tool", name: "Read", input: { file_path: "src/a.ts" }, result: "ENOENT", isError: true, streaming: false });
  });

  it("turns compaction, rate limits, retries and results into system rows", () => {
    const feed = applyMessages(emptyFeed(), [
      sdkMessages.init(S),
      sdkMessages.compactBoundary(S, { trigger: "auto", pre_tokens: 150_000, post_tokens: 20_000 }),
      sdkMessages.rateLimitEvent(S, { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.85 }),
      sdkMessages.apiRetry(S, "server_error", { attempt: 2, max_retries: 3, retry_delay_ms: 2000, error_status: 500 }),
      sdkMessages.resultSuccess(S, "done"),
      sdkMessages.resultError(S, ["boom"]),
    ]);
    expect(feed.items.map((item) => [item.kind, (item as { level?: string }).level, (item as { text: string }).text])).toEqual([
      ["system", "info", "процесс запущен · claude-sonnet-4-5"],
      ["system", "info", "контекст сжат (auto): 150k -> 20k токенов"],
      ["system", "info", "лимит подписки: allowed_warning · five_hour · 85 %"],
      ["system", "warn", "повтор запроса к API: попытка 2 из 3 через 2 с (server_error, 500)"],
      ["system", "info", "Ход завершён (end_turn)"],
      ["system", "warn", "Ход завершился ошибкой (error_during_execution): boom"],
    ]);
  });

  it("keeps thinking as its own row and the prompt as a user row", () => {
    const feed = applyMessages(emptyFeed(), [sdkMessages.userText(S, "Implement issue 7"), sdkMessages.assistantThinking(S, "Let me look around.")]);
    expect(feed.items.map((item) => item.kind)).toEqual(["user", "thinking"]);
  });

  it("nests the messages of a subagent under the tool call that started it", () => {
    const feed = applyMessages(emptyFeed(), [
      sdkMessages.assistantToolUse(S, "toolu_sub", "Agent", { description: "Find the callers", prompt: "..." }),
      sdkMessages.taskStarted(S, "toolu_sub", "Find the callers", "Explore"),
      sdkMessages.assistantToolUse(S, "toolu_grep", "Grep", { pattern: "callers" }, { parent_tool_use_id: "toolu_sub" }),
      sdkMessages.toolResult(S, "toolu_grep", "a.ts:1", { parent_tool_use_id: "toolu_sub" }),
      sdkMessages.assistantText(S, "Two callers.", { parent_tool_use_id: "toolu_sub" }),
      sdkMessages.toolResult(S, "toolu_sub", "Two callers: a.ts, b.ts"),
    ]);
    expect(topLevelOf(feed.items)).toHaveLength(1);
    expect(topLevelOf(feed.items)[0]).toMatchObject({ kind: "tool", id: "toolu_sub", subagent: { type: "Explore", description: "Find the callers" }, result: "Two callers: a.ts, b.ts" });
    expect(childrenOf(feed.items, "toolu_sub").map((item) => item.kind)).toEqual(["tool", "text"]);
  });

  it("applies a message only once, however many times the history and the live stream repeat it", () => {
    const greeting = sdkMessages.assistantText(S, "Hello");
    const once = applyMessage(emptyFeed(), greeting);
    const twice = applyMessage(once, greeting);
    expect(twice).toBe(once);
    expect(twice.items).toHaveLength(1);
  });
});
