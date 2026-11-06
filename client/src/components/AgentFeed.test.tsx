import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sdkMessages } from "../../../src/fakes/sdk-messages.js";
import type { SessionId } from "../../../src/ids.js";
import { applyMessages, emptyFeed } from "../feed.js";
import { AgentFeed } from "./AgentFeed.js";

const S = "11111111-1111-4111-8111-111111111111" as SessionId;

const renderFeed = (feed = emptyFeed()) => render(<AgentFeed feed={feed} status="live" error={null} />);

describe("AgentFeed", () => {
  it("shows streamed text with a cursor until the message is complete", () => {
    const streaming = applyMessages(emptyFeed(), [
      sdkMessages.messageStart(S, "msg_1"),
      sdkMessages.contentBlockStart(S, 0, { type: "text", text: "" }),
      sdkMessages.textDelta(S, 0, "Reading the iss"),
    ]);
    const { rerender } = renderFeed(streaming);
    expect(screen.getByTestId("feed-text")).toHaveTextContent("Reading the iss");
    expect(screen.getByTestId("feed-text")).toHaveAttribute("data-streaming", "true");

    const complete = applyMessages(streaming, [sdkMessages.textDelta(S, 0, "ue."), sdkMessages.contentBlockStop(S, 0), sdkMessages.messageStop(S)]);
    rerender(<AgentFeed feed={complete} status="live" error={null} />);
    expect(screen.getByTestId("feed-text")).toHaveTextContent("Reading the issue.");
    expect(screen.getByTestId("feed-text")).toHaveAttribute("data-streaming", "false");
  });

  it("renders the Agent text as formatted Markdown, not as raw markup", () => {
    renderFeed(applyMessages(emptyFeed(), [sdkMessages.assistantText(S, "## Plan\n\n- read **the issue**\n- run `npm test`\n\n| a | b |\n| - | - |\n| 1 | 2 |")]));
    const text = screen.getByTestId("feed-text");
    expect(within(text).getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(within(text).getAllByRole("listitem")).toHaveLength(2);
    expect(within(text).getByText("the issue").tagName).toBe("STRONG");
    expect(within(text).getByText("npm test").tagName).toBe("CODE");
    expect(within(text).getByRole("table")).toBeInTheDocument();
    expect(text).not.toHaveTextContent("**");
  });

  it("folds the launch prompt of the Session and unfolds it on demand", () => {
    renderFeed(applyMessages(emptyFeed(), [sdkMessages.userText(S, "# Стадия\n\nImplement issue 7"), sdkMessages.assistantText(S, "On it."), sdkMessages.userText(S, "Fix the blocker")]));
    const prompt = screen.getByTestId("feed-prompt");
    expect(prompt).not.toHaveAttribute("open");
    expect(prompt.querySelector("summary")).toHaveTextContent("Промпт запуска");
    fireEvent.click(prompt.querySelector("summary") as HTMLElement);
    expect(prompt).toHaveAttribute("open");
    expect(within(prompt).getByRole("heading", { name: "Стадия" })).toBeInTheDocument();
    expect(screen.getAllByTestId("feed-prompt")).toHaveLength(1);
    expect(screen.getByTestId("feed-user")).toHaveTextContent("Fix the blocker");
  });

  it("collapses a tool call to one line and unfolds the input and the result", () => {
    renderFeed(
      applyMessages(emptyFeed(), [
        sdkMessages.assistantToolUse(S, "toolu_1", "Bash", { command: "npm test" }),
        sdkMessages.toolResult(S, "toolu_1", "12 passed"),
      ]),
    );
    const tool = screen.getByTestId("feed-tool");
    expect(tool).not.toHaveAttribute("open");
    expect(tool.querySelector("summary")).toHaveTextContent("Bash npm test");
    fireEvent.click(tool.querySelector("summary") as HTMLElement);
    expect(tool).toHaveAttribute("open");
    expect(tool).toHaveTextContent('"command": "npm test"');
    expect(tool).toHaveTextContent("result: 12 passed");
  });

  it("renders system rows grey, thinking collapsed and a subagent as a nested block", () => {
    renderFeed(
      applyMessages(emptyFeed(), [
        sdkMessages.compactBoundary(S),
        sdkMessages.assistantThinking(S, "Hidden thoughts"),
        sdkMessages.assistantToolUse(S, "toolu_sub", "Agent", { description: "Find the callers", prompt: "..." }),
        sdkMessages.taskStarted(S, "toolu_sub", "Find the callers", "Explore"),
        sdkMessages.assistantText(S, "Two callers.", { parent_tool_use_id: "toolu_sub" }),
      ]),
    );
    expect(screen.getByTestId("feed-system")).toHaveTextContent("контекст сжат (auto): 150k -> 20k токенов");
    expect(screen.getByTestId("feed-system")).toHaveAttribute("data-level", "info");
    const thinking = screen.getByTestId("feed-thinking");
    expect(thinking).not.toHaveAttribute("open");
    expect(thinking.querySelector("summary")).toHaveTextContent("thinking");
    const subagent = screen.getByTestId("feed-subagent");
    expect(subagent).toHaveTextContent("сабагент Explore: Find the callers");
    expect(within(subagent).getByTestId("feed-text")).toHaveTextContent("Two callers.");
  });

  it("tells about the loading and the failure of the history", () => {
    const { rerender } = render(<AgentFeed feed={emptyFeed()} status="loading" error={null} />);
    expect(screen.getByTestId("agent-feed")).toHaveTextContent("Загрузка истории Сессии…");
    rerender(<AgentFeed feed={emptyFeed()} status="error" error="internal error" />);
    expect(screen.getByRole("alert")).toHaveTextContent("История не загружена: internal error");
  });
});
