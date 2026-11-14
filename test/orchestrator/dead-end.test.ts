import { afterEach, describe, expect, it } from "vitest";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import { isMarkedComment } from "../../src/orchestrator/comments.js";
import { findLastAssistantText, LAST_MESSAGE_MAX_CHARS, quoteMarkdown, truncateMessage } from "../../src/orchestrator/last-message.js";
import type { TasksResponse } from "../../src/server/app.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

const SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const ISSUE = 42 as IssueNumber;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("last message of an Agent", () => {
  it("takes the last text of an assistant message or a successful result and skips tool calls", () => {
    expect(
      findLastAssistantText([
        sdkMessages.assistantText(SESSION, "first"),
        sdkMessages.assistantText(SESSION, "  second  "),
        sdkMessages.assistantToolUse(SESSION, "tool-1", "Bash", { command: "ls" }),
      ]),
    ).toBe("second");
    expect(findLastAssistantText([sdkMessages.assistantText(SESSION, "said"), sdkMessages.resultSuccess(SESSION, "final")])).toBe("final");
    expect(findLastAssistantText([sdkMessages.resultError(SESSION, ["boom"])])).toBeUndefined();
    expect(findLastAssistantText([])).toBeUndefined();
  });

  it("keeps the tail of a long message and quotes every line", () => {
    const long = `${"a".repeat(LAST_MESSAGE_MAX_CHARS)}end`;
    const cut = truncateMessage(long);
    expect(cut).toHaveLength(LAST_MESSAGE_MAX_CHARS);
    expect(cut.startsWith("...")).toBe(true);
    expect(cut.endsWith("end")).toBe(true);
    expect(truncateMessage("short")).toBe("short");
    expect(quoteMarkdown("one\n\ntwo")).toBe("> one\n>\n> two");
  });
});

describe("Dead end context", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  const implementing = async (): Promise<TestApp> => {
    const testApp = createTestApp();
    open.push(testApp);
    testApp.orchestrator.canStartTurn = () => false;
    testApp.ports.github.seedIssue({ number: 42, title: "Add login", body: "A login form.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    return testApp;
  };

  it("quotes the last message of the current Agent in the comment, stores it and serves it with the stuck Task", async () => {
    const s = await implementing();
    const process = s.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));
    process.emit(sdkMessages.assistantText(SESSION, "Сделал форму.\nЖду CI."));
    await flush();

    await s.orchestrator.deadEnds.enter(ISSUE, "test reason", "Причина для человека.");

    const comment = s.ports.github.commentsOf(42).find((c) => isMarkedComment(c.body, "stuck:1"))?.body;
    expect(comment).toContain("Тупик: Причина для человека.\n\nПоследнее сообщение Реализатора:\n\n> Сделал форму.\n> Жду CI.\n\nЗадача передана человеку.");
    const implementer = s.index.agents.listByIssue(ISSUE)[0];
    expect(s.index.deadEnds.find(ISSUE, 1)).toMatchObject({ agentId: implementer?.id, agentRole: "implementer", lastMessage: "Сделал форму.\nЖду CI." });
    expect(s.ports.driver.log.of("getSessionHistory")).toHaveLength(0);
    const body = (await (await s.request("/api/tasks")).json()) as TasksResponse;
    expect(body.stuck).toEqual([
      expect.objectContaining({ issueNumber: 42, reason: "test reason", lastMessage: { agentId: implementer?.id, role: "implementer", text: "Сделал форму.\nЖду CI." } }),
    ]);
  });

  it("reads the Session history when the feed holds no text, and leaves the quote out when there is none", async () => {
    const s = await implementing();
    const process = s.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));
    await flush();
    s.ports.driver.histories.set(SESSION, [sdkMessages.assistantText(SESSION, "из истории")]);

    await s.orchestrator.deadEnds.enter(ISSUE, "test reason", "Причина.");

    expect(s.ports.driver.log.of("getSessionHistory")).toHaveLength(1);
    expect(s.ports.github.commentsOf(42).at(-1)?.body).toContain("> из истории");
    expect(s.index.deadEnds.find(ISSUE, 1)?.lastMessage).toBe("из истории");
  });

  it("posts the reason alone when the Agent said nothing", async () => {
    const s = await implementing();
    await s.orchestrator.deadEnds.enter(ISSUE, "test reason", "Причина.");
    const comment = s.ports.github.commentsOf(42).at(-1)?.body;
    expect(comment).toContain("Тупик: Причина.\n\nЗадача передана человеку.");
    expect(comment).not.toContain("Последнее сообщение");
    const body = (await (await s.request("/api/tasks")).json()) as TasksResponse;
    expect(body.stuck[0]?.lastMessage).toBeNull();
  });
});
