import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import { isMarkedComment } from "../../src/orchestrator/comments.js";
import { CHECKS_POLL_MS, CHECKS_TIMEOUT_MS, evaluateChecks, MERGEABLE_POLL_MS } from "../../src/orchestrator/merge.js";
import type { CheckRun, CommitStatus } from "../../src/ports/github.js";
import type { TasksResponse } from "../../src/server/app.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const IMPLEMENTER_SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const QA_SESSION = "22222222-2222-4222-8222-222222222222" as SessionId;
const ISSUE = 42 as IssueNumber;
const BRANCH = "worktree-issue-42";
const WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42`;
// Head of the pull request the fake opens for the branch.
const HEAD_SHA = "sha-1";

const approved = JSON.stringify({ approved: true, summary: "Всё на месте", blockers: [] });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

type Scenario = TestApp & { implementer: FakeAgentProcess };

const MERGE_CALLS = new Set([
  "getPullRequest",
  "updatePullRequest",
  "listCheckRuns",
  "listCommitStatuses",
  "mergePullRequest",
  "deleteBranch",
  "updateIssue",
  "createIssueComment",
  "addLabels",
  "removeAssignees",
]);

describe("Merge Stage", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  // A taken Task whose Implementer finished and whose QA approved: the Task is in `merge`, nothing merged
  // yet. `setup` shapes the pull request and its checks before the Merge Stage looks at them.
  const approvedTask = async (setup: (testApp: TestApp) => void = () => {}): Promise<Scenario> => {
    const testApp = createTestApp();
    open.push(testApp);
    const { github, driver } = testApp.ports;
    github.seedIssue({ number: 42, title: "Add login", body: "A login form.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const implementer = driver.lastLaunch();
    implementer.emit(sdkMessages.init(IMPLEMENTER_SESSION));
    implementer.emit(sdkMessages.resultSuccess(IMPLEMENTER_SESSION, "done"));
    await flush();
    const qa = driver.lastLaunch();
    qa.emit(sdkMessages.init(QA_SESSION));
    qa.emit(sdkMessages.resultSuccess(QA_SESSION, approved));
    await flush();
    expect(testApp.index.tasks.get(ISSUE).stage).toBe("merge");
    setup(testApp);
    github.log.clear();
    testApp.ports.worktree.log.clear();
    return { ...testApp, implementer };
  };

  const mergeCalls = (s: TestApp): string[] => s.ports.github.log.methods().filter((method) => MERGE_CALLS.has(method));

  const tasks = async (s: TestApp): Promise<TasksResponse> => (await s.request("/api/tasks")).json() as Promise<TasksResponse>;

  it("merges an approved pull request without checks: WIP off, squash with the title and an empty body, remote branch gone, issue completed, final comment", async () => {
    const s = await approvedTask();
    const { github, worktree } = s.ports;
    expect(github.pull(1).title).toBe("WIP: Add login");
    let commentedBeforeCleanup = false;
    const removeWorktree = worktree.removeWorktree.bind(worktree);
    worktree.removeWorktree = async (input) => {
      commentedBeforeCleanup = github.log.methods().includes("createIssueComment");
      await removeWorktree(input);
    };

    await s.orchestrator.pollOnce();

    expect(mergeCalls(s)).toEqual([
      "getPullRequest",
      "updatePullRequest",
      "listCheckRuns",
      "listCommitStatuses",
      "getPullRequest",
      "mergePullRequest",
      "deleteBranch",
      "updateIssue",
      "createIssueComment",
      // The cleanup looks at the pull request once more before it touches anything.
      "getPullRequest",
    ]);
    expect(github.log.of("updatePullRequest")[0]?.args).toEqual([1, { title: "Add login" }]);
    expect(github.log.of("listCheckRuns")[0]?.args).toEqual([HEAD_SHA]);
    expect(github.log.of("mergePullRequest")[0]?.args).toEqual([1, { method: "squash", commitTitle: "Add login", commitMessage: "" }]);
    expect(github.log.of("deleteBranch")[0]?.args).toEqual([BRANCH]);
    expect(github.log.of("updateIssue")[0]?.args).toEqual([42, { state: "closed", stateReason: "completed" }]);
    expect(github.pull(1)).toMatchObject({ merged: true, title: "Add login" });
    expect(github.issue(42)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(github.deletedBranches).toEqual([BRANCH]);

    const comment = github.commentsOf(42).find((c) => isMarkedComment(c.body, "done:1"));
    expect(comment?.body).toContain(github.pull(1).htmlUrl);
    expect(comment?.body).toContain(IMPLEMENTER_SESSION);
    expect(github.commentsOf(42)).toHaveLength(1);

    expect(commentedBeforeCleanup).toBe(true);
    expect(worktree.worktrees(TEST_REPO_PATH)).toEqual([]);
    expect(worktree.branches(TEST_REPO_PATH)).toEqual(["main"]);
    expect(worktree.log.methods()).toEqual(["listWorktrees", "removeWorktree", "listBranches", "deleteBranch"]);

    expect(s.implementer.calls.map((call) => call.method)).toContain("stop");
    expect(s.index.agents.listByIssue(ISSUE).every((agent) => agent.state === "stopped")).toBe(true);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "done", pullNumber: 1 });
    expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "merge", to: "done", reason: "pull request merged" });
    expect(s.orchestrator.slots()).toEqual({ used: 0, max: 2 });
    expect(s.index.intents.listPending()).toEqual([]);
    expect(s.orchestrator.merge.isWaiting(ISSUE)).toBe(false);

    const body = await tasks(s);
    expect(body.inProgress).toEqual([]);
    expect(body.stuck).toEqual([]);
    expect(body.slots).toEqual({ used: 0, max: 2 });
  });

  it("waits for check runs and commit statuses to finish, polling them through the clock", async () => {
    const s = await approvedTask((testApp) => {
      testApp.ports.github.seedCheckRun(HEAD_SHA, { id: 7, name: "ci", status: "in_progress" });
      testApp.ports.github.seedCommitStatus(HEAD_SHA, { context: "lint", state: "pending" });
    });
    const { github, clock } = s.ports;

    await s.orchestrator.pollOnce();
    expect(github.pull(1)).toMatchObject({ merged: false, title: "Add login" });
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");
    expect(github.log.of("listCheckRuns")).toHaveLength(1);
    expect(s.orchestrator.merge.isWaiting(ISSUE)).toBe(true);

    await clock.advance(CHECKS_POLL_MS);
    await flush();
    expect(github.log.of("listCheckRuns")).toHaveLength(2);
    expect(github.log.of("mergePullRequest")).toHaveLength(0);
    expect(github.log.of("updatePullRequest")).toHaveLength(1);

    github.seedCheckRun(HEAD_SHA, { id: 7, name: "ci", status: "completed", conclusion: "success" });
    await clock.advance(CHECKS_POLL_MS);
    await flush();
    expect(github.log.of("mergePullRequest")).toHaveLength(0);

    github.seedCommitStatus(HEAD_SHA, { context: "lint", state: "success" });
    await clock.advance(CHECKS_POLL_MS);
    await flush();
    expect(github.pull(1).merged).toBe(true);
    expect(github.issue(42).state).toBe("closed");
    expect(s.index.tasks.get(ISSUE).stage).toBe("done");
    expect(s.orchestrator.slots().used).toBe(0);
    expect(s.orchestrator.merge.isWaiting(ISSUE)).toBe(false);
  });

  it("does not poll checks twice when a cycle runs while a wait timer is pending", async () => {
    const s = await approvedTask((testApp) => {
      testApp.ports.github.seedCheckRun(HEAD_SHA, { name: "ci", status: "queued" });
    });
    await s.orchestrator.pollOnce();
    await s.orchestrator.pollOnce();
    expect(s.ports.github.log.of("listCheckRuns")).toHaveLength(1);
    expect(s.orchestrator.merge.isWaiting(ISSUE)).toBe(true);
  });

  it("waits for mergeability computed after the checks and merges once it is known", async () => {
    const s = await approvedTask((testApp) => testApp.ports.github.humanSetMergeable(1, null));
    const { github, clock } = s.ports;
    await s.orchestrator.pollOnce();
    expect(github.pull(1).merged).toBe(false);
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");

    github.humanSetMergeable(1, true);
    await clock.advance(MERGEABLE_POLL_MS);
    await flush();
    expect(github.pull(1).merged).toBe(true);
    expect(s.index.tasks.get(ISSUE).stage).toBe("done");
  });

  it("hands a conflict with the base branch to the Merger instead of a dead end", async () => {
    const s = await approvedTask((testApp) => testApp.ports.github.humanSetMergeable(1, false, "dirty"));
    const { github, driver } = s.ports;
    await s.orchestrator.pollOnce();

    expect(github.pull(1)).toMatchObject({ merged: false, state: "open", title: "Add login" });
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");
    expect(driver.lastLaunch().launch.prompt).toContain("Стадии «Merge»");
    expect(github.issue(42).labels).not.toContain("ready-for-human");
    expect(github.commentsOf(42)).toEqual([]);
    expect(s.index.intents.listPending()).toEqual([]);
  });

  it("reaches a dead end when the merge itself fails", async () => {
    const s = await approvedTask();
    const { github } = s.ports;
    github.mergePullRequest = async (number, input) => {
      github.log.record("mergePullRequest", number, input);
      return { merged: false, reason: "Base branch was modified" };
    };
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(s.index.transitions.listFor(ISSUE).at(-1)?.reason).toBe("merge failed: Base branch was modified");
    expect(github.commentsOf(42).find((c) => isMarkedComment(c.body, "stuck:1"))?.body).toContain("Base branch was modified");
    expect(github.issue(42).state).toBe("open");
    expect(s.index.intents.listPending()).toEqual([]);
  });

  it("hands red checks to the Implementer without merging", async () => {
    const s = await approvedTask((testApp) => {
      testApp.ports.github.seedCheckRun(HEAD_SHA, { name: "build", conclusion: "success" });
      testApp.ports.github.seedCheckRun(HEAD_SHA, { name: "test", conclusion: "failure" });
      testApp.ports.github.seedCommitStatus(HEAD_SHA, { context: "lint", state: "error" });
    });
    const { github } = s.ports;
    await s.orchestrator.pollOnce();
    expect(github.log.of("mergePullRequest")).toHaveLength(0);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "implement", round: 1 });
    expect(s.implementer.sent).toEqual([expect.stringContaining("test, lint")]);
    expect(s.orchestrator.merge.isWaiting(ISSUE)).toBe(false);
  });

  it("reaches a dead end when the checks hang for an hour on the same head", async () => {
    const s = await approvedTask((testApp) => {
      testApp.ports.github.seedCheckRun(HEAD_SHA, { name: "ci", status: "in_progress" });
    });
    const { github, clock } = s.ports;
    await s.orchestrator.pollOnce();
    await clock.advance(CHECKS_TIMEOUT_MS - CHECKS_POLL_MS);
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");

    await clock.advance(CHECKS_POLL_MS);
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    expect(s.index.transitions.listFor(ISSUE).at(-1)?.reason).toBe("merge: checks not finished in 60 min");
    expect(github.log.of("mergePullRequest")).toHaveLength(0);
    expect(s.orchestrator.merge.isWaiting(ISSUE)).toBe(false);
  });

  it("finishes an interrupted merge on the next cycle without merging twice", async () => {
    const s = await approvedTask();
    const { github } = s.ports;
    const deleteBranch = github.deleteBranch.bind(github);
    github.deleteBranch = async (name) => {
      github.log.record("deleteBranch", name);
      throw new Error("502 Bad Gateway");
    };
    await s.orchestrator.pollOnce();
    expect(github.pull(1).merged).toBe(true);
    expect(s.index.tasks.get(ISSUE).stage).toBe("merge");
    expect(github.issue(42).state).toBe("open");
    expect(s.index.intents.listPending().map((intent) => intent.kind)).toEqual(["delete-remote-branch"]);

    github.deleteBranch = deleteBranch;
    await s.orchestrator.pollOnce();
    expect(github.log.of("mergePullRequest")).toHaveLength(1);
    expect(github.log.of("deleteBranch")).toHaveLength(2);
    expect(github.deletedBranches).toEqual([BRANCH]);
    expect(github.log.of("updateIssue")).toHaveLength(1);
    expect(github.issue(42).state).toBe("closed");
    expect(github.commentsOf(42).filter((c) => isMarkedComment(c.body, "done:1"))).toHaveLength(1);
    expect(s.index.tasks.get(ISSUE).stage).toBe("done");
    expect(s.index.intents.listPending()).toEqual([]);
  });
});

describe("evaluateChecks", () => {
  const run = (overrides: Partial<CheckRun>): CheckRun => ({
    id: 1,
    name: "ci",
    status: "completed",
    conclusion: "success",
    htmlUrl: "",
    startedAt: null,
    completedAt: null,
    ...overrides,
  });
  const status = (overrides: Partial<CommitStatus>): CommitStatus => ({ context: "lint", state: "success", targetUrl: null, updatedAt: "", ...overrides });

  it("treats no checks at all as nothing to wait for", () => {
    expect(evaluateChecks([], [])).toEqual({ state: "none" });
  });

  it("is pending while any run is not completed or any status is pending", () => {
    expect(evaluateChecks([run({ status: "queued", conclusion: null })], [])).toEqual({ state: "pending" });
    expect(evaluateChecks([run({})], [status({ state: "pending" })])).toEqual({ state: "pending" });
  });

  it("is red on a failed, cancelled or timed out run and on a failed or errored status, naming them", () => {
    expect(evaluateChecks([run({ name: "a", conclusion: "cancelled" }), run({ id: 2, name: "b", conclusion: "timed_out" })], [status({ context: "c", state: "failure" })])).toEqual({
      state: "red",
      failed: ["a", "b", "c"],
    });
  });

  it("is green with skipped and neutral runs", () => {
    expect(evaluateChecks([run({ conclusion: "skipped" }), run({ id: 2, name: "n", conclusion: "neutral" })], [status({})])).toEqual({ state: "green" });
  });

  it("is still pending when one run is red but another is not finished", () => {
    expect(evaluateChecks([run({ conclusion: "failure" }), run({ id: 2, name: "b", status: "in_progress", conclusion: null })], [])).toEqual({ state: "pending" });
  });
});
