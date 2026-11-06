import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import { isMarkedComment } from "../../src/orchestrator/comments.js";
import { CHECKS_POLL_MS, CHECKS_TIMEOUT_MS } from "../../src/orchestrator/merge.js";
import { EXTRA_ROUND_REASON, MERGER_STARTED_REASON } from "../../src/orchestrator/merger.js";
import { MAX_QA_ROUNDS_KEY } from "../../src/orchestrator/qa.js";
import type { TasksResponse } from "../../src/server/app.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const IMPLEMENTER_SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const MERGER_SESSION = "33333333-3333-4333-8333-333333333333" as SessionId;
const ISSUE = 42 as IssueNumber;
const WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42`;
const HEAD_SHA = "sha-1";
const MERGED_SHA = "sha-merged";

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

describe("Merger and CI as a round", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  // A taken Task whose Implementer finished and whose first QA round approved: the Task is in `merge`.
  const approvedTask = async (setup: (testApp: TestApp) => void = () => {}): Promise<Scenario> => {
    const testApp = createTestApp();
    open.push(testApp);
    setup(testApp);
    const { github, driver } = testApp.ports;
    github.seedIssue({ number: 42, title: "Add login", body: "A login form.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const implementer = driver.lastLaunch();
    implementer.emit(sdkMessages.init(IMPLEMENTER_SESSION));
    implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "done"));
    await flush();
    await verdict(testApp, approved);
    expect(testApp.index.tasks.get(ISSUE)).toMatchObject({ stage: "merge", round: 0 });
    github.log.clear();
    return { ...testApp, implementer };
  };

  // The QA process of the current round answers with `text` as its last message.
  const verdict = async (s: TestApp, text: string): Promise<FakeAgentProcess> => {
    const qa = s.ports.driver.lastLaunch();
    expect(qa.launch.prompt).toContain("Стадии «QA»");
    const session = qa.sessionId() ?? qaSession();
    qa.emit(sdkMessages.init(session));
    qa.emit(sdkMessages.resultSuccess(session, text));
    await flush();
    return qa;
  };

  // The Merge Stage finds a conflict and brings the Merger up.
  const conflicted = async (setup?: (testApp: TestApp) => void): Promise<Scenario & { merger: FakeAgentProcess }> => {
    const s = await approvedTask(setup);
    s.ports.github.humanSetMergeable(1, false, "dirty");
    await s.orchestrator.pollOnce();
    const merger = s.ports.driver.lastLaunch();
    expect(merger.launch.prompt).toContain("Стадии «Merge»");
    return { ...s, merger };
  };

  // The Merger pushes the resolved branch and ends its Turn.
  const mergerDone = async (s: TestApp, merger: FakeAgentProcess, text = "готово"): Promise<void> => {
    s.ports.github.agentPush(1, MERGED_SHA);
    merger.emit(sdkMessages.init(MERGER_SESSION));
    merger.emit(sdkMessages.resultSuccess(MERGER_SESSION, text));
    await flush();
  };

  const transitions = (s: TestApp) => s.index.transitions.listFor(ISSUE).map((t) => [t.from, t.to, t.reason]);
  const tasks = async (s: TestApp): Promise<TasksResponse> => (await s.app.request("/api/tasks")).json() as Promise<TasksResponse>;

  it("brings a Merger up in the worktree on a conflict instead of a dead end, with the merge prompt and the base branch", async () => {
    const s = await conflicted();
    const { github, driver } = s.ports;
    const launch = s.merger.launch;
    expect(launch.cwd).toBe(WORKTREE);
    expect(launch.resume).toBeUndefined();
    expect(launch.prompt).toContain("git merge origin/main");
    expect(launch.prompt).toContain("Issue #42: Add login");
    expect(launch.prompt).toContain("Pull request: #1");
    expect(launch.prompt).toContain("`ask_human`");
    expect(launch.prompt).not.toMatch(/\{\{/);

    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "merge", round: 0 });
    expect(transitions(s).at(-1)).toEqual(["merge", "merge", MERGER_STARTED_REASON]);
    expect(s.index.agents.listByIssue(ISSUE).map((agent) => [agent.role, agent.state])).toEqual([
      ["implementer", "idle"],
      ["qa", "stopped"],
      ["merger", "running"],
    ]);
    expect(github.issue(42)).toMatchObject({ state: "open", assignees: [github.login] });
    expect(github.issue(42).labels).not.toContain("ready-for-human");
    expect(github.commentsOf(42)).toEqual([]);
    expect(github.pull(1).merged).toBe(false);
    expect(s.orchestrator.merger.isResolving(s.index.tasks.get(ISSUE))).toBe(true);
    expect(s.orchestrator.slots().used).toBe(1);

    // While the Merger works, the Stage leaves the pull request alone and starts no second Merger.
    github.log.clear();
    await s.orchestrator.pollOnce();
    await s.orchestrator.pollOnce();
    expect(driver.launches.filter((process) => process.launch.prompt?.includes("Стадии «Merge»"))).toHaveLength(1);
    expect(github.log.of("getPullRequest")).toHaveLength(0);
    expect(github.log.of("mergePullRequest")).toHaveLength(0);
    expect((await tasks(s)).inProgress[0]).toMatchObject({ issueNumber: 42, stage: "merge" });
  });

  it("runs one extra QA round after the Merger, outside the limit, and merges on approval", async () => {
    const s = await conflicted((testApp) => testApp.index.installation.set(MAX_QA_ROUNDS_KEY, "1"));
    const { github, driver } = s.ports;
    await mergerDone(s, s.merger);

    expect(s.merger.calls.map((call) => call.method)).toContain("stop");
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "qa", round: 0 });
    expect(transitions(s).at(-1)).toEqual(["merge", "qa", EXTRA_ROUND_REASON]);
    expect(s.orchestrator.qa.isExtraRound(ISSUE)).toBe(true);
    const qa = driver.lastLaunch();
    expect(qa.launch.prompt).toContain("Стадии «QA»");
    expect(qa.launch.prompt).toContain("Круг 1 проверки");
    expect(qa.launch.prompt).toContain("Вердикт QA: approved");
    expect(github.log.of("mergePullRequest")).toHaveLength(0);

    await verdict(s, approved);
    expect(transitions(s).at(-1)).toEqual(["qa", "merge", "qa extra round: approved"]);
    await s.orchestrator.pollOnce();
    expect(github.log.of("listCheckRuns").at(-1)?.args).toEqual([MERGED_SHA]);
    expect(github.pull(1).merged).toBe(true);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "done", round: 0 });
    expect(transitions(s)).toEqual([
      [null, "taken", null],
      ["taken", "implement", "implementer started"],
      ["implement", "qa", "implementer turn finished"],
      ["qa", "merge", "qa round 1: approved"],
      ["merge", "merge", MERGER_STARTED_REASON],
      ["merge", "qa", EXTRA_ROUND_REASON],
      ["qa", "merge", "qa extra round: approved"],
      ["merge", "done", "pull request merged"],
    ]);
    expect(s.index.agents.listByIssue(ISSUE).every((agent) => agent.state === "stopped")).toBe(true);
  });

  it("sends blockers of the extra round to the Implementer as usual without counting the round or hitting the limit", async () => {
    const s = await conflicted((testApp) => testApp.index.installation.set(MAX_QA_ROUNDS_KEY, "1"));
    const { github, driver } = s.ports;
    await mergerDone(s, s.merger);
    await verdict(s, blocked("merge broke the null check"));

    expect(s.implementer.sent).toEqual([expect.stringContaining("src/login.ts:10: merge broke the null check")]);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "implement", round: 0 });
    expect(transitions(s).at(-1)).toEqual(["qa", "implement", "qa extra round: 1 blockers"]);
    expect(github.issue(42).labels).not.toContain("ready-for-human");

    // The next round is a regular one again: it counts and the limit applies.
    s.implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "fixed"));
    await flush();
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "qa", round: 0 });
    expect(s.orchestrator.qa.isExtraRound(ISSUE)).toBe(false);
    expect(driver.lastLaunch().launch.prompt).toContain("Круг 1 проверки");
    await verdict(s, blocked("still broken"));
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(transitions(s).at(-1)).toEqual(["qa", "stuck", "qa rounds exhausted: 1 of 1"]);
  });

  it("brings a Merger up again when the base branch moved during the extra round", async () => {
    const s = await conflicted();
    const { github, driver } = s.ports;
    await mergerDone(s, s.merger);
    await verdict(s, approved);
    github.humanSetMergeable(1, false, "dirty");
    await s.orchestrator.pollOnce();
    const second = driver.lastLaunch();
    expect(second).not.toBe(s.merger);
    expect(second.launch.prompt).toContain("Стадии «Merge»");
    expect(second.launch.resume).toBeUndefined();
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");
    expect(transitions(s).at(-1)).toEqual(["merge", "merge", MERGER_STARTED_REASON]);
  });

  it("reaches a dead end when the Merger ends its Turn without pushing anything", async () => {
    const s = await conflicted();
    const { github } = s.ports;
    s.merger.emit(sdkMessages.init(MERGER_SESSION));
    s.merger.emit(sdkMessages.resultSuccess(MERGER_SESSION, "не смог"));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(transitions(s).at(-1)).toEqual(["merge", "stuck", "merge: conflict left unresolved"]);
    expect(github.issue(42).labels).toContain("ready-for-human");
    expect(github.commentsOf(42).find((c) => isMarkedComment(c.body, "stuck:1"))?.body).toContain("конфликт");
    expect(s.index.agents.listByIssue(ISSUE).every((agent) => agent.state === "stopped")).toBe(true);
    expect(s.ports.worktree.worktrees(TEST_REPO_PATH).map((info) => info.path)).toEqual([WORKTREE]);
  });

  it("reaches a dead end when the Merger Turn fails", async () => {
    const s = await conflicted();
    s.merger.emit(sdkMessages.init(MERGER_SESSION));
    s.merger.emit(sdkMessages.resultError(MERGER_SESSION, ["tool crashed"]));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(transitions(s).at(-1)).toEqual(["merge", "stuck", "merger turn failed"]);
    expect(s.ports.github.commentsOf(42).find((c) => isMarkedComment(c.body, "stuck:1"))?.body).toContain("Merger");
  });

  it("does not start the Merger while the Installation is paused and starts it once the Pause is lifted", async () => {
    const s = await approvedTask();
    const { github, driver } = s.ports;
    github.humanSetMergeable(1, false, "dirty");
    s.orchestrator.installation.pause("human", "lunch");
    await s.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(2);
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");
    expect(github.issue(42).labels).not.toContain("ready-for-human");

    s.orchestrator.installation.unpause();
    await s.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(3);
    expect(driver.lastLaunch().launch.prompt).toContain("Стадии «Merge»");
  });

  it("sends red checks to the Implementer as a remark, counts the round and merges once the new head is green", async () => {
    const s = await approvedTask((testApp) => {
      testApp.ports.github.seedCheckRun(HEAD_SHA, { name: "build", conclusion: "success" });
      testApp.ports.github.seedCheckRun(HEAD_SHA, { name: "test", conclusion: "failure" });
      testApp.ports.github.seedCommitStatus(HEAD_SHA, { context: "lint", state: "error" });
    });
    const { github, driver } = s.ports;
    await s.orchestrator.pollOnce();

    expect(github.log.of("mergePullRequest")).toHaveLength(0);
    expect(github.pull(1)).toMatchObject({ merged: false, title: "Add login" });
    expect(s.implementer.sent).toHaveLength(1);
    expect(s.implementer.sent[0]).toContain("pull request #1");
    expect(s.implementer.sent[0]).toContain("test, lint");
    expect(s.implementer.sent[0]).toContain("gh pr checks 1");
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "implement", round: 1 });
    expect(transitions(s).at(-1)).toEqual(["merge", "implement", "red checks: test, lint"]);
    expect(driver.launches).toHaveLength(2);
    expect(github.issue(42).labels).not.toContain("ready-for-human");
    expect((await tasks(s)).inProgress[0]).toMatchObject({ issueNumber: 42, stage: "implement", round: 1 });

    github.agentPush(1, "sha-2");
    github.seedCheckRun("sha-2", { name: "test", conclusion: "success" });
    s.implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "fixed"));
    await flush();
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "qa", round: 1 });
    expect(driver.lastLaunch().launch.prompt).toContain("Круг 2 проверки");
    await verdict(s, approved);
    expect(transitions(s).at(-1)).toEqual(["qa", "merge", "qa round 2: approved"]);
    await s.orchestrator.pollOnce();
    expect(github.log.of("listCheckRuns").at(-1)?.args).toEqual(["sha-2"]);
    expect(github.pull(1).merged).toBe(true);
    expect(s.index.tasks.get(ISSUE).stage).toBe("done");
  });

  it("reaches a dead end on red checks when the limit of rounds is exhausted", async () => {
    const s = await approvedTask((testApp) => {
      testApp.index.installation.set(MAX_QA_ROUNDS_KEY, "1");
      testApp.ports.github.seedCheckRun(HEAD_SHA, { name: "test", conclusion: "failure" });
    });
    const { github } = s.ports;
    await s.orchestrator.pollOnce();
    expect(s.implementer.sent).toEqual([]);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "stuck", round: 0 });
    expect(transitions(s).at(-1)).toEqual(["merge", "stuck", "qa rounds exhausted: 1 of 1"]);
    expect(github.issue(42).labels).toContain("ready-for-human");
    expect(github.issue(42).assignees).toEqual([]);
    const comment = github.commentsOf(42).find((c) => isMarkedComment(c.body, "stuck:1"));
    expect(comment?.body).toContain("test");
    expect(comment?.body).toContain("1 из 1");
    expect(github.pull(1).merged).toBe(false);
  });

  it("reaches a dead end with the reason when the checks hang for an hour, with no Merger and no remark", async () => {
    const s = await approvedTask((testApp) => {
      testApp.ports.github.seedCheckRun(HEAD_SHA, { name: "ci", status: "in_progress" });
    });
    const { clock, driver } = s.ports;
    await s.orchestrator.pollOnce();
    await clock.advance(CHECKS_TIMEOUT_MS - CHECKS_POLL_MS);
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");

    await clock.advance(CHECKS_POLL_MS);
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(transitions(s).at(-1)).toEqual(["merge", "stuck", "merge: checks not finished in 60 min"]);
    expect(s.implementer.sent).toEqual([]);
    expect(driver.launches).toHaveLength(2);
    expect((await tasks(s)).stuck).toEqual([expect.objectContaining({ issueNumber: 42, reason: "merge: checks not finished in 60 min" })]);
  });
});
