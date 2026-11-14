import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { AgentId, IssueNumber, SessionId, ToolUseId } from "../../src/ids.js";
import { DEAD_END_ASK_HUMAN_ANSWER, DEAD_END_QUESTION_NOTE } from "../../src/orchestrator/dead-end-questions.js";
import { MAX_QA_ROUNDS_KEY } from "../../src/orchestrator/qa.js";
import type { AskAgentResponse } from "../../src/server/api-types.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const IMPLEMENTER_SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const QA_SESSION = "22222222-2222-4222-8222-222222222222" as SessionId;
const MERGER_SESSION = "33333333-3333-4333-8333-333333333333" as SessionId;
const ISSUE = 42 as IssueNumber;
const IMPLEMENTER_ID = 1 as AgentId;
const WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42`;

const approved = JSON.stringify({ approved: true, summary: "Всё на месте", blockers: [] });
const blocked = JSON.stringify({ approved: false, summary: "Есть замечания", blockers: [{ where: "src/login.ts:10", what: "нет проверки" }] });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("a question to the Agent of a Task in a dead end", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  // A taken Task whose Implementer announced its Session and is mid-Turn.
  const taken = async (setup: (testApp: TestApp) => void = () => {}): Promise<TestApp & { implementer: FakeAgentProcess }> => {
    const testApp = createTestApp();
    open.push(testApp);
    setup(testApp);
    testApp.ports.github.seedIssue({ number: ISSUE, title: "Add login", body: "A login form.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const implementer = testApp.ports.driver.lastLaunch();
    implementer.emit(sdkMessages.init(IMPLEMENTER_SESSION));
    await flush();
    return { ...testApp, implementer };
  };

  const stuckAtImplementer = async () => {
    const s = await taken();
    await s.orchestrator.deadEnds.enter(ISSUE, "implementer turn failed twice", "Ход Реализатора дважды завершился ошибкой.");
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(s.index.agents.get(IMPLEMENTER_ID)).toMatchObject({ state: "stopped" });
    return s;
  };

  const ask = (s: TestApp, text: string, issue: number = ISSUE) => s.request(`/api/tasks/${issue}/agent/ask`, json({ text }));
  const transitions = (s: TestApp) => s.index.transitions.listFor(ISSUE).map((t) => [t.from, t.to, t.reason]);
  const GITHUB_WRITES = ["addLabels", "removeLabel", "addAssignees", "removeAssignees", "updateIssue", "createIssueComment", "updateIssueComment", "createPullRequest", "mergePullRequest", "updatePullRequest", "deleteBranch"];
  const githubWrites = (s: TestApp) => s.ports.github.log.methods().filter((method) => GITHUB_WRITES.includes(method));

  it("resumes the Session of the last step in the worktree with the note, and stops it once the Turn is over", async () => {
    const s = await stuckAtImplementer();
    const before = transitions(s);
    const launches = s.ports.driver.launches.length;
    s.ports.github.log.clear();

    const response = await ask(s, "  Почему ты остановился?  ");
    expect(response.status).toBe(200);
    expect(((await response.json()) as AskAgentResponse).agent).toMatchObject({ id: 1, role: "implementer", state: "running" });
    const answering = s.ports.driver.lastLaunch();
    expect(s.ports.driver.launches).toHaveLength(launches + 1);
    expect(answering.launch).toMatchObject({ cwd: WORKTREE, resume: IMPLEMENTER_SESSION });
    expect(answering.launch.prompt).toBe(`${DEAD_END_QUESTION_NOTE}\n\nСообщение человека:\n\nПочему ты остановился?`);
    expect(DEAD_END_QUESTION_NOTE).toContain("Не меняй код, не коммить и не пушь");
    // ask_human gets an answer at once instead of a Request in the issue.
    expect(await answering.askHuman({ toolUseId: "toolu_1" as ToolUseId, question: "Что делать?", options: undefined })).toEqual({ kind: "allow", answer: DEAD_END_ASK_HUMAN_ANSWER });

    answering.emit(sdkMessages.assistantText(IMPLEMENTER_SESSION, "Тесты падали в CI, я не успел запушить."));
    answering.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "Тесты падали в CI, я не успел запушить."));
    await flush();

    expect(answering.calls.map((call) => call.method)).toContain("stop");
    expect(s.index.agents.get(IMPLEMENTER_ID)).toMatchObject({ state: "stopped", pid: null });
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(transitions(s)).toEqual(before);
    // No QA round, no new Agent, nothing written to GitHub.
    expect(s.ports.driver.launches).toHaveLength(launches + 1);
    expect(githubWrites(s)).toEqual([]);
    expect(s.ports.github.issue(ISSUE).labels).toContain("ready-for-human");
  });

  it("lets the human ask again after the answer, and refuses while the Agent is still answering", async () => {
    const s = await stuckAtImplementer();
    expect((await ask(s, "Что в worktree?")).status).toBe(200);
    const busy = await ask(s, "И ещё вопрос");
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "Агент уже отвечает" });

    const first = s.ports.driver.lastLaunch();
    first.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "Чисто."));
    await flush();
    expect((await ask(s, "И ещё вопрос")).status).toBe(200);
    expect(s.ports.driver.lastLaunch()).not.toBe(first);
    expect(s.ports.driver.lastLaunch().launch.resume).toBe(IMPLEMENTER_SESSION);
  });

  it("refuses a Task not in a dead end, an unknown Task, an empty text and new Turns on hold", async () => {
    const s = await taken();
    const working = await ask(s, "Как дела?");
    expect(working.status).toBe(409);
    expect(await working.json()).toEqual({ error: "Задача не в Тупике" });
    expect((await ask(s, "Как дела?", 999)).status).toBe(404);

    await s.orchestrator.deadEnds.enter(ISSUE, "implementer turn failed twice", "Ход Реализатора дважды завершился ошибкой.");
    expect((await ask(s, "   ")).status).toBe(400);

    s.orchestrator.installation.pause("human", "lunch");
    const paused = await ask(s, "Что случилось?");
    expect(paused.status).toBe(409);
    expect(((await paused.json()) as { error: string }).error).toContain("Паузе");
    expect(s.index.agents.get(IMPLEMENTER_ID).state).toBe("stopped");
  });

  it("keeps the Task in the dead end when the Merger answers, without an extra QA round", async () => {
    const s = await taken();
    s.implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "done"));
    await flush();
    const qa = s.ports.driver.lastLaunch();
    qa.emit(sdkMessages.init(QA_SESSION));
    qa.emit(sdkMessages.resultSuccess(QA_SESSION, approved));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");
    s.ports.github.humanSetMergeable(1, false, "dirty");
    await s.orchestrator.pollOnce();
    const merger = s.ports.driver.lastLaunch();
    merger.emit(sdkMessages.init(MERGER_SESSION));
    merger.emit(sdkMessages.resultError(MERGER_SESSION, ["tool crashed"]));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    const before = transitions(s);
    const launches = s.ports.driver.launches.length;

    expect((await ask(s, "Что с конфликтом?")).status).toBe(200);
    const answering = s.ports.driver.lastLaunch();
    expect(answering.launch).toMatchObject({ cwd: WORKTREE, resume: MERGER_SESSION });
    s.ports.github.agentPush(1, "sha-after-question");
    answering.emit(sdkMessages.resultSuccess(MERGER_SESSION, "Конфликт разрешён, но тесты не дождался."));
    await flush();
    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(transitions(s)).toEqual(before);
    expect(s.ports.driver.launches).toHaveLength(launches + 1);
  });

  it("takes no verdict from a QA Agent that answers a question after the rounds ran out", async () => {
    const s = await taken((testApp) => testApp.index.installation.set(MAX_QA_ROUNDS_KEY, "1"));
    s.implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "done"));
    await flush();
    const qa = s.ports.driver.lastLaunch();
    qa.emit(sdkMessages.init(QA_SESSION));
    qa.emit(sdkMessages.resultSuccess(QA_SESSION, blocked));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    const before = transitions(s);

    expect((await ask(s, "Насколько всё плохо?")).status).toBe(200);
    const answering = s.ports.driver.lastLaunch();
    expect(answering.launch.resume).toBe(QA_SESSION);
    answering.emit(sdkMessages.resultSuccess(QA_SESSION, approved));
    await flush();

    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(transitions(s)).toEqual(before);
    expect(answering.calls.map((call) => call.method)).toContain("stop");
  });
});
