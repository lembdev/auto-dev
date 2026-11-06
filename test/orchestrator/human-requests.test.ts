import { afterEach, describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId, ToolUseId } from "../../src/ids.js";
import { isMarkedComment } from "../../src/orchestrator/comments.js";
import { parseRequestComment, requestCommentText } from "../../src/orchestrator/human-requests.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { AskHumanCall } from "../../src/ports/driver.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const ISSUE = 42 as IssueNumber;
const WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42`;
const TOOL_USE_ID = "toolu_01" as ToolUseId;
const CALL: AskHumanCall = { toolUseId: TOOL_USE_ID, question: "Which colour for the button?", options: ["red", "blue"] };

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// The SDK result of a Turn ended by the deferred ask_human call, as the prototype recorded it.
const deferredResult = (call: AskHumanCall) =>
  sdkMessages.resultSuccess(SESSION, "", {
    stop_reason: "tool_deferred",
    terminal_reason: "tool_deferred",
    deferred_tool_use: { id: call.toolUseId, name: ASK_HUMAN_TOOL_NAME, input: { question: call.question, options: call.options } },
  });

describe("the Request comment text", () => {
  it("is parsed back into the question and the options", () => {
    const text = { question: "Which colour?\n\nThe old one is red.", options: ["red", "blue"] };
    expect(parseRequestComment(`${requestCommentText("qa", text)}\n\n<!-- auto-dev -->\n<!-- auto-dev:request:x -->`)).toEqual(text);
    expect(parseRequestComment(requestCommentText("implementer", { question: "Go?", options: undefined }))).toEqual({ question: "Go?", options: undefined });
    expect(parseRequestComment("just a human comment")).toBeUndefined();
  });
});

describe("Human requests through ask_human", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  const seedTask = (testApp: TestApp, number = 42) =>
    testApp.ports.github.seedIssue({ number, title: `Task ${number}`, body: "Build it.", labels: ["ready-for-agent"] });

  // A taken Task whose Implementer has asked a question and been deferred: the Agent waits.
  const waiting = async (beforeTake?: (testApp: TestApp) => void): Promise<TestApp & { first: FakeAgentProcess }> => {
    const testApp = createTestApp();
    open.push(testApp);
    seedTask(testApp);
    beforeTake?.(testApp);
    await testApp.orchestrator.pollOnce();
    const first = testApp.ports.driver.lastLaunch();
    first.emit(sdkMessages.init(SESSION));
    expect(await first.askHuman(CALL)).toEqual({ kind: "defer" });
    first.emit(deferredResult(CALL));
    first.end();
    await flush();
    return { ...testApp, first };
  };

  it("defers the first ask_human call, records the request and publishes exactly one marked Request comment in the issue", async () => {
    const s = await waiting();
    const { github } = s.ports;

    expect(s.index.agents.listByIssue(ISSUE)[0]).toMatchObject({ state: "waiting", pid: null });
    expect(s.index.tasks.get(ISSUE).stage).toBe("implement");

    const comments = github.commentsOf(42);
    expect(comments).toHaveLength(1);
    const request = comments[0]!;
    expect(request.author).toBe(github.login);
    expect(isMarkedComment(request.body)).toBe(true);
    expect(request.body).toContain("Реализация");
    expect(request.body).toContain("Which colour for the button?");
    expect(request.body).toContain("- red\n- blue");
    expect(request.body).toContain("Ответьте комментарием здесь или в UI.");
    expect(github.commentsOf(1)).toEqual([]);

    const rows = s.index.humanRequests.listOpen();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issueNumber: ISSUE, toolUseId: TOOL_USE_ID, commentId: request.id, answeredAt: null });
    expect(rows[0]!.agentId).toBe(s.index.agents.listByIssue(ISSUE)[0]!.id);

    await s.orchestrator.pollOnce();
    expect(github.commentsOf(42)).toHaveLength(1);
  });

  it("frees the Slot while the Agent waits, so the next Ready task is taken without a timeout", async () => {
    const s = await waiting();
    expect(s.orchestrator.slots()).toEqual({ used: 0, max: 2 });
    s.index.installation.set("max_parallel_tasks", "1");
    seedTask(s, 43);
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(43 as IssueNumber).stage).toBe("implement");
    expect(s.ports.driver.launches).toHaveLength(2);

    await s.ports.clock.advance(24 * 60 * 60_000);
    expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("waiting");
  });

  it("takes the first unmarked comment after the Request as the Answer, reacts with a rocket and resumes the Session with the Answer", async () => {
    const s = await waiting();
    const { github, driver } = s.ports;
    const requestComment = github.commentsOf(42)[0]!;
    await s.orchestrator.postComment(ISSUE, "note", "Status note from the Orchestrator");
    const answer = github.humanComment(42, "blue, please", "bob");
    await s.orchestrator.pollOnce();

    expect(github.reactions).toEqual([{ commentId: answer.id, content: "rocket", user: github.login }]);
    expect(driver.launches).toHaveLength(2);
    const resumed = driver.lastLaunch();
    expect(resumed.launch).toMatchObject({ cwd: WORKTREE, resume: SESSION });
    expect(resumed.launch.prompt).toBeUndefined();
    expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("running");
    expect(s.orchestrator.slots().used).toBe(1);

    const decision = await resumed.askHuman(CALL);
    expect(decision).toMatchObject({ kind: "allow", answer: "blue, please" });
    expect(decision.kind === "allow" ? decision.source : "").toContain("bob");
    expect(decision.kind === "allow" ? decision.source : "").toContain(answer.htmlUrl);

    expect(s.index.appliedAnswers.find({ kind: "github", id: String(answer.id) })).toMatchObject({ requestId: s.index.humanRequests.listByIssue(ISSUE)[0]!.id });
    expect(s.index.humanRequests.listOpen()).toEqual([]);
    expect(s.index.humanRequests.listByIssue(ISSUE)[0]?.commentId).toBe(requestComment.id);

    resumed.emit(sdkMessages.init(SESSION));
    resumed.emit(sdkMessages.assistantText(SESSION, "blue it is"));
    resumed.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("qa");
  });

  it("ignores marked comments, comments in other issues and comments written before the Request", async () => {
    let old = 0;
    const s = await waiting((testApp) => {
      old = testApp.ports.github.humanComment(42, "written before the question").id;
    });
    const { github, driver } = s.ports;
    const other = github.seedIssue({ number: 43, title: "Other" });
    github.humanComment(other.number, "unrelated");
    await s.orchestrator.postComment(ISSUE, "note", "Status note from the Orchestrator");
    // An edit of a comment older than the Request shows up in the poll, but the comment is still not an Answer.
    await s.ports.clock.advance(1_000);
    github.humanEditComment(old, "still before the question");

    await s.orchestrator.pollOnce();
    expect(github.reactions).toHaveLength(0);
    expect(driver.launches).toHaveLength(1);
    expect(s.index.humanRequests.listOpen()).toHaveLength(1);
  });

  it("applies an Answer once: a second poll, an edit or a deletion of the comment changes nothing", async () => {
    const s = await waiting();
    const { github, driver } = s.ports;
    const answer = github.humanComment(42, "blue");
    await s.orchestrator.pollOnce();
    const resumed = driver.lastLaunch();
    await resumed.askHuman(CALL);
    resumed.emit(sdkMessages.init(SESSION));
    resumed.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();
    // The end of the Turn hands the Task to QA, whose own Agent starts; only resumes of the Session count here.
    const resumes = () => driver.launches.filter((launch) => launch.launch.resume === SESSION).length;
    expect(resumes()).toBe(1);

    await s.ports.clock.advance(1_000);
    github.humanEditComment(answer.id, "green actually");
    await s.orchestrator.pollOnce();
    expect(resumes()).toBe(1);
    expect(github.reactions).toHaveLength(1);
    expect(resumed.sent).toEqual([]);

    github.humanDeleteComment(answer.id);
    await s.orchestrator.pollOnce();
    expect(resumes()).toBe(1);
    expect(s.index.appliedAnswers.find({ kind: "github", id: String(answer.id) })).toBeDefined();
  });

  it("delivers the Answer after a restart: the open request survives in the index and the resumed process gets the ask_human handler", async () => {
    const s = await waiting();
    const { github, driver } = s.ports;
    await s.orchestrator.shutdown();

    const restarted = new Orchestrator({ ports: s.ports, index: s.index, log: s.log, product: { repoPath: TEST_REPO_PATH } });
    const answer = github.humanComment(42, "red");
    await restarted.pollOnce();

    expect(driver.launches).toHaveLength(2);
    const resumed = driver.lastLaunch();
    expect(resumed.launch).toMatchObject({ resume: SESSION });
    expect(await resumed.askHuman(CALL)).toMatchObject({ kind: "allow", answer: "red" });
    expect(github.reactions).toEqual([{ commentId: answer.id, content: "rocket", user: github.login }]);
    await restarted.shutdown();
  });

  it("delivers an Answer that arrived while the Orchestrator was down, even if its comment is outside the poll window", async () => {
    const s = await waiting();
    const { github, driver } = s.ports;
    await s.orchestrator.shutdown();
    const answer = github.humanComment(42, "red");
    // The cursor moved past the Answer: only the bootstrap check of open requests can find it.
    s.index.installation.set("poll.comments.since", new Date(s.ports.clock.now() + 60_000).toISOString());

    const restarted = new Orchestrator({ ports: s.ports, index: s.index, log: s.log, product: { repoPath: TEST_REPO_PATH } });
    await restarted.pollOnce();
    expect(driver.launches).toHaveLength(2);
    expect(await driver.lastLaunch().askHuman(CALL)).toMatchObject({ kind: "allow", answer: "red" });
    expect(github.reactions.map((reaction) => reaction.commentId)).toEqual([answer.id]);
    await restarted.shutdown();
  });

  it("keeps the Answer for the next cycle when the resume fails", async () => {
    const s = await waiting();
    const { github, driver } = s.ports;
    github.humanComment(42, "blue");
    const launch = driver.launch.bind(driver);
    driver.launch = () => {
      throw new Error("claude not found");
    };
    await s.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(1);
    expect(s.index.humanRequests.listOpen()).toHaveLength(1);

    driver.launch = launch;
    await s.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(2);
    expect(await driver.lastLaunch().askHuman(CALL)).toMatchObject({ kind: "allow", answer: "blue" });
    expect(s.index.humanRequests.listOpen()).toEqual([]);
  });
});
