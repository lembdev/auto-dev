import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId, ToolUseId } from "../../src/ids.js";
import { isMarkedComment } from "../../src/orchestrator/comments.js";
import { MAX_QA_ROUNDS_KEY, VERDICT_RETRY_PROMPT } from "../../src/orchestrator/qa.js";
import type { TasksResponse } from "../../src/server/app.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const IMPLEMENTER_SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const ISSUE = 42 as IssueNumber;
const WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42`;

const approved = JSON.stringify({ approved: true, summary: "Всё на месте", blockers: [] });
const blocked = (what: string) =>
  JSON.stringify({ approved: false, summary: "Есть замечания", blockers: [{ where: "src/login.ts:10", what }] });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

let qaSessions = 0;
const qaSession = (): SessionId => {
  qaSessions += 1;
  return `22222222-2222-4222-8222-${String(qaSessions).padStart(12, "0")}` as SessionId;
};

type Scenario = TestApp & { implementer: FakeAgentProcess };

describe("QA Stage", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  // A taken Task whose Implementer has just finished its first Turn: the Task is in `qa`.
  const implemented = async (setup: (testApp: TestApp) => void = () => {}): Promise<Scenario> => {
    const testApp = createTestApp();
    open.push(testApp);
    setup(testApp);
    const { github, driver } = testApp.ports;
    github.seedIssue({ number: 7, title: "Accounts", type: "Epic", body: "- [ ] Users can log in\n" });
    github.seedIssue({
      number: 42,
      title: "Add login",
      body: "## What to build\n\nA login form.\n\n## Acceptance criteria\n\n- [ ] form submits",
      labels: ["ready-for-agent"],
      parentIssueNumber: 7 as IssueNumber,
    });
    await testApp.orchestrator.pollOnce();
    const implementer = driver.lastLaunch();
    implementer.emit(sdkMessages.init(IMPLEMENTER_SESSION));
    implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "done"));
    await flush();
    return { ...testApp, implementer };
  };

  // The QA process of the current round answers with `text` as its last message.
  const verdict = async (s: TestApp, text: string): Promise<FakeAgentProcess> => {
    const qa = s.ports.driver.lastLaunch();
    const session = qa.sessionId() ?? qaSession();
    qa.emit(sdkMessages.init(session));
    qa.emit(sdkMessages.assistantText(session, text));
    qa.emit(sdkMessages.resultSuccess(session, text));
    await flush();
    return qa;
  };

  const tasks = async (s: TestApp): Promise<TasksResponse> => (await s.request("/api/tasks")).json() as Promise<TasksResponse>;

  it("starts a new QA Session in the worktree when the Task enters qa, with the issue, Epic and pull request in the prompt", async () => {
    const s = await implemented();
    const { driver } = s.ports;
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "qa", round: 0 });
    expect(driver.launches).toHaveLength(2);
    const launch = driver.lastLaunch().launch;
    expect(launch.cwd).toBe(WORKTREE);
    expect(launch.resume).toBeUndefined();
    const prompt = launch.prompt ?? "";
    expect(prompt).toContain("Стадии «QA»");
    expect(prompt).toContain("Круг 1 проверки");
    expect(prompt).toContain("Issue #42: Add login");
    expect(prompt).toContain("- [ ] form submits");
    expect(prompt).toContain("Epic #7: Accounts");
    expect(prompt).toContain("gh pr diff 1");
    expect(prompt).toContain("Прошлого вердикта нет");
    const agents = s.index.agents.listByIssue(ISSUE);
    expect(agents.map((agent) => [agent.role, agent.state])).toEqual([
      ["implementer", "idle"],
      ["qa", "running"],
    ]);
    expect(s.orchestrator.slots()).toEqual({ used: 1, max: 2 });
  });

  it("sends blockers into the Implementer Session, counts the round and checks again with a fresh QA Session", async () => {
    const s = await implemented();
    const { driver, clock } = s.ports;
    const firstQa = await verdict(s, `Проверил.\n\n${blocked("no null check")}`);

    expect(s.implementer.sent).toHaveLength(1);
    expect(s.implementer.sent[0]).toContain("src/login.ts:10: no null check");
    expect(firstQa.calls.map((call) => call.method)).toContain("stop");
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "implement", round: 1 });
    expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "qa", to: "implement", reason: "qa round 1: 1 blockers" });
    expect(driver.launches).toHaveLength(2);

    await clock.advance(1_000);
    s.implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "fixed"));
    await flush();
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "qa", round: 1 });
    expect(driver.launches).toHaveLength(3);
    const secondQa = driver.lastLaunch();
    expect(secondQa.launch.resume).toBeUndefined();
    expect(secondQa.launch.prompt).toContain("Круг 2 проверки");
    expect(secondQa.launch.prompt).toContain("Вердикт QA: not approved");
    expect(secondQa.launch.prompt).toContain("1. src/login.ts:10: no null check");
    expect(s.index.agents.listByIssue(ISSUE).map((agent) => [agent.role, agent.state])).toEqual([
      ["implementer", "idle"],
      ["qa", "stopped"],
      ["qa", "running"],
    ]);

    const body = await tasks(s);
    expect(body.maxQaRounds).toBe(3);
    expect(body.inProgress[0]).toMatchObject({ issueNumber: 42, stage: "qa", round: 1 });

    await verdict(s, approved);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "merge", round: 1 });
    expect(s.index.transitions.listFor(ISSUE).map((t) => [t.from, t.to])).toEqual([
      [null, "taken"],
      ["taken", "implement"],
      ["implement", "qa"],
      ["qa", "implement"],
      ["implement", "qa"],
      ["qa", "merge"],
    ]);
    expect(s.index.transitions.listFor(ISSUE).at(-1)?.reason).toBe("qa round 2: approved");
    expect(s.orchestrator.slots().used).toBe(1);
  });

  it("treats approved with blockers as blockers", async () => {
    const s = await implemented();
    await verdict(s, JSON.stringify({ approved: true, summary: "ok", blockers: [{ where: "tests", what: "missing" }] }));
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "implement", round: 1 });
    expect(s.implementer.sent[0]).toContain("tests: missing");
  });

  it("asks the same QA Session for JSON only once, and reaches a dead end on the second failure", async () => {
    const s = await implemented();
    const { github, driver } = s.ports;
    const qa = await verdict(s, "Всё хорошо, одобряю.");
    expect(qa.sent).toEqual([VERDICT_RETRY_PROMPT]);
    expect(driver.launches).toHaveLength(2);
    expect(s.index.tasks.get(ISSUE).stage).toBe("qa");

    const session = qa.sessionId()!;
    qa.emit(sdkMessages.resultSuccess(session, approved));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");

    const other = await implemented();
    const otherQa = await verdict(other, "Одобряю.");
    otherQa.emit(sdkMessages.resultSuccess(otherQa.sessionId()!, "Правда одобряю."));
    await flush();
    expect(other.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(other.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "qa", to: "stuck", reason: "qa verdict unparsable twice" });
    const comment = other.ports.github.commentsOf(42).find((c) => isMarkedComment(c.body, "stuck:1"));
    expect(comment?.body).toContain("Правда одобряю.");
    expect(github.commentsOf(42)).toHaveLength(0);
  });

  it("reaches a dead end when the rounds are exhausted: label, assignee, reason, Agents stopped, worktree kept", async () => {
    const s = await implemented((testApp) => testApp.index.installation.set(MAX_QA_ROUNDS_KEY, "2"));
    const { github, driver, worktree, clock } = s.ports;
    await verdict(s, blocked("first"));
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "implement", round: 1 });
    await clock.advance(1_000);
    s.implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "fixed"));
    await flush();
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "qa", round: 1 });

    await verdict(s, blocked("still wrong"));

    expect(s.implementer.sent).toHaveLength(1);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "stuck", round: 1 });
    expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "qa", to: "stuck", reason: "qa rounds exhausted: 2 of 2" });
    expect(github.issue(42).labels).toContain("ready-for-human");
    expect(github.issue(42).assignees).toEqual([]);
    const comment = github.commentsOf(42).find((c) => isMarkedComment(c.body, "stuck:1"));
    expect(comment?.body).toContain("Исчерпан лимит Кругов QA (2 из 2)");
    expect(comment?.body).toContain("src/login.ts:10: still wrong");
    expect(s.index.agents.listByIssue(ISSUE).every((agent) => agent.state === "stopped")).toBe(true);
    expect(driver.launches.every((launch) => launch.calls.some((call) => call.method === "stop"))).toBe(true);
    expect(s.orchestrator.slots()).toEqual({ used: 0, max: 2 });
    expect(worktree.worktrees(TEST_REPO_PATH).map((info) => info.path)).toEqual([WORKTREE]);
    expect(worktree.log.of("removeWorktree")).toHaveLength(0);
    expect(github.deletedBranches).toEqual([]);
    expect(s.index.intents.listPending()).toEqual([]);

    const body = await tasks(s);
    expect(body.inProgress).toEqual([]);
    expect(body.stuck).toEqual([expect.objectContaining({ issueNumber: 42, stage: "stuck", round: 1, reason: "qa rounds exhausted: 2 of 2" })]);
  });

  it("uses three rounds by default", async () => {
    const s = await implemented();
    for (let round = 1; round <= 2; round += 1) {
      await verdict(s, blocked(`round ${round}`));
      expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "implement", round });
      await s.ports.clock.advance(1_000);
      s.implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "fixed"));
      await flush();
    }
    await verdict(s, blocked("round 3"));
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(s.implementer.sent).toHaveLength(2);
    expect(s.index.transitions.listFor(ISSUE).at(-1)?.reason).toBe("qa rounds exhausted: 3 of 3");
  });

  it("does not start a round while new Turns are on hold and starts it on the next cycle afterwards", async () => {
    const testApp = createTestApp();
    open.push(testApp);
    testApp.orchestrator.canStartTurn = () => false;
    const { github, driver } = testApp.ports;
    github.seedIssue({ number: 42, title: "Add login", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const implementer = driver.lastLaunch();
    implementer.emit(sdkMessages.init(IMPLEMENTER_SESSION));
    implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "done"));
    await flush();
    expect(testApp.index.tasks.get(ISSUE).stage).toBe("qa");
    expect(driver.launches).toHaveLength(1);

    await testApp.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(1);

    testApp.orchestrator.canStartTurn = () => true;
    await testApp.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(2);
    expect(driver.lastLaunch().launch).toMatchObject({ cwd: WORKTREE });
    expect(testApp.index.agents.listByIssue(ISSUE).at(-1)).toMatchObject({ role: "qa", state: "running" });

    await testApp.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(2);
  });

  it("starts a fresh round after a restart for a Task left in qa", async () => {
    const s = await implemented();
    const { driver } = s.ports;
    expect(driver.launches).toHaveLength(2);
    driver.lastLaunch().end();
    await flush();
    await s.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(3);
    expect(driver.lastLaunch().launch.resume).toBeUndefined();
  });

  it("checks again with a new Session when the QA Turn fails, and gives up after the second failure", async () => {
    const s = await implemented();
    const { driver } = s.ports;
    const qa = driver.lastLaunch();
    const session = qaSession();
    qa.emit(sdkMessages.init(session));
    qa.emit(sdkMessages.resultError(session, ["boom"]));
    await flush();
    expect(driver.launches).toHaveLength(3);
    expect(s.index.tasks.get(ISSUE).stage).toBe("qa");

    const retry = driver.lastLaunch();
    const retrySession = qaSession();
    retry.emit(sdkMessages.init(retrySession));
    retry.emit(sdkMessages.resultError(retrySession, ["boom again"]));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(s.index.transitions.listFor(ISSUE).at(-1)?.reason).toBe("qa turn failed twice");
  });

  it("keeps the waiting QA Agent through a Request: no new round starts, the Answer resumes it and its verdict moves the Task on", async () => {
    const s = await implemented();
    const { driver, github, clock } = s.ports;
    const qa = driver.lastLaunch();
    const session = qaSession();
    const call = { toolUseId: "toolu_qa" as ToolUseId, question: "Is the old form still needed?", options: undefined };
    qa.emit(sdkMessages.init(session));
    expect(await qa.askHuman(call)).toEqual({ kind: "defer" });
    qa.emit(
      sdkMessages.resultSuccess(session, "", {
        stop_reason: "tool_deferred",
        terminal_reason: "tool_deferred",
        deferred_tool_use: { id: call.toolUseId, name: ASK_HUMAN_TOOL_NAME, input: { question: call.question } },
      }),
    );
    qa.end();
    await flush();
    const qaAgent = s.index.agents.listByIssue(ISSUE).find((agent) => agent.role === "qa")!;
    expect(qaAgent.state).toBe("waiting");

    await s.orchestrator.pollOnce();
    await clock.advance(60_000);
    await s.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(2);
    expect(s.index.agents.listByIssue(ISSUE).filter((agent) => agent.role === "qa")).toHaveLength(1);

    github.humanComment(42, "no, drop it");
    await s.orchestrator.pollOnce();
    await flush();
    expect(driver.launches).toHaveLength(3);
    const resumed = driver.lastLaunch();
    expect(resumed.launch.resume).toBe(session);
    resumed.emit(sdkMessages.init(session));
    resumed.emit(sdkMessages.assistantText(session, approved));
    resumed.emit(sdkMessages.resultSuccess(session, approved));
    await flush();

    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");
    expect(s.index.agents.listByIssue(ISSUE).filter((agent) => agent.role === "qa")).toHaveLength(1);
  });
});
