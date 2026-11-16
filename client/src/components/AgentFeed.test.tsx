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

  it("shows an approving QA verdict as a card, not as JSON", () => {
    renderFeed(
      applyMessages(emptyFeed(), [
        sdkMessages.assistantText(S, 'Checked everything.\n\n```json\n{ "approved": true, "summary": "slugify done, `npm test` green", "blockers": [] }\n```'),
      ]),
    );
    const card = screen.getByTestId("feed-verdict");
    expect(card).toHaveAttribute("data-approved", "true");
    expect(card).toHaveTextContent("Вердикт QA: одобрено");
    expect(within(card).getByText("npm test").tagName).toBe("CODE");
    expect(screen.getByTestId("feed-text")).toHaveTextContent("Checked everything.");
    expect(screen.queryByText(/"approved"/)).not.toBeInTheDocument();
  });

  it("lists the blockers of a rejecting QA verdict with where they are", () => {
    renderFeed(
      applyMessages(emptyFeed(), [
        sdkMessages.assistantText(S, '{"approved": false, "summary": "Tests are weak.", "blockers": [{"where": "test/slugify.test.js", "what": "no case for empty input"}]}'),
      ]),
    );
    const card = screen.getByTestId("feed-verdict");
    expect(card).toHaveAttribute("data-approved", "false");
    expect(card).toHaveTextContent("Вердикт QA: не одобрено");
    expect(within(card).getAllByRole("listitem")).toHaveLength(1);
    expect(within(card).getByRole("listitem")).toHaveTextContent("test/slugify.test.js: no case for empty input");
    expect(screen.queryByTestId("feed-text")).not.toBeInTheDocument();
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
    expect(tool.querySelector("summary")).toHaveTextContent("Bashnpm test");
    fireEvent.click(tool.querySelector("summary") as HTMLElement);
    expect(tool).toHaveAttribute("open");
    expect(tool).toHaveTextContent("$ npm test");
    expect(tool).toHaveTextContent("Результат12 passed");
  });

  it("gathers a run of steps into one card and folds its early part", () => {
    const calls = Array.from({ length: 9 }, (_, i) => [
      sdkMessages.assistantToolUse(S, `toolu_${i}`, "Read", { file_path: `src/file-${i}.ts` }),
      sdkMessages.toolResult(S, `toolu_${i}`, "ok"),
    ]).flat();
    renderFeed(applyMessages(emptyFeed(), [...calls, sdkMessages.assistantText(S, "Done.")]));
    expect(screen.getAllByTestId("feed-steps")).toHaveLength(1);
    expect(screen.getAllByTestId("feed-tool")).toHaveLength(5);
    fireEvent.click(screen.getByTestId("feed-steps-more"));
    expect(screen.getAllByTestId("feed-tool")).toHaveLength(9);
  });

  it("leaves out a thought the model kept to itself", () => {
    renderFeed(applyMessages(emptyFeed(), [sdkMessages.assistantThinking(S, ""), sdkMessages.assistantText(S, "Next.")]));
    expect(screen.queryByTestId("feed-thinking")).not.toBeInTheDocument();
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
    expect(thinking.querySelector("summary")).toHaveTextContent("РазмышлениеHidden thoughts");
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

  it("shows a question to the human as a card waiting for the Answer, not as a folded step", () => {
    renderFeed(applyMessages(emptyFeed(), [sdkMessages.assistantToolUse(S, "toolu_ask", "mcp__human__ask_human", { question: "Which colour?", options: ["blue", "red"] })]));
    const card = screen.getByTestId("feed-ask");
    expect(card).toHaveAttribute("data-answered", "false");
    expect(card).toHaveTextContent("Агент спрашивает");
    expect(card).toHaveTextContent("ждёт ответа");
    expect(screen.getByTestId("feed-ask-question")).toHaveTextContent("Which colour?");
    expect(screen.queryByTestId("feed-steps")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feed-answer")).not.toBeInTheDocument();
  });

  it("shows the Answer from the UI as the human's bubble under the question", () => {
    renderFeed(
      applyMessages(emptyFeed(), [
        sdkMessages.assistantToolUse(S, "toolu_ask", "mcp__human__ask_human", { question: "Which colour?", options: ["blue", "red"] }),
        sdkMessages.toolResult(S, "toolu_ask", "blue\n\n(answered by the human in the auto-dev UI)"),
      ]),
    );
    expect(screen.getByTestId("feed-ask")).toHaveAttribute("data-answered", "true");
    const answer = screen.getByTestId("feed-answer");
    expect(answer).toHaveTextContent("Ответ");
    expect(answer).toHaveTextContent("blue");
    expect(answer).not.toHaveTextContent("answered by");
  });

  it("links the Answer from GitHub to its comment and its author", () => {
    renderFeed(
      applyMessages(emptyFeed(), [
        sdkMessages.assistantToolUse(S, "toolu_ask", "mcp__human__ask_human", { question: "Ship it?" }),
        sdkMessages.toolResult(S, "toolu_ask", "yes\n\n(answered by bob in GitHub comment https://github.com/acme/product/issues/7#issuecomment-1)"),
      ]),
    );
    const answer = screen.getByTestId("feed-answer");
    expect(answer).toHaveTextContent("yes");
    expect(within(answer).getByRole("link", { name: "@bob в GitHub" })).toHaveAttribute("href", "https://github.com/acme/product/issues/7#issuecomment-1");
  });

  it("says the Agent works while a Turn runs and nothing streams", () => {
    render(<AgentFeed feed={applyMessages(emptyFeed(), [sdkMessages.assistantText(S, "On it.")])} status="live" error={null} working />);
    expect(screen.getByTestId("feed-working")).toHaveTextContent("Агент работает…");
  });
});
