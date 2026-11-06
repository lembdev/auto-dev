import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import { MAX_QA_ROUNDS_KEY } from "../../src/orchestrator/qa.js";
import type { TasksResponse } from "../../src/server/app.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const IMPLEMENTER_SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const QA_SESSION = "22222222-2222-4222-8222-222222222222" as SessionId;
const ISSUE = 42 as IssueNumber;
const WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42`;
const RETRY_WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42-r2`;
const BRANCH = "worktree-issue-42";
const RETRY_BRANCH = "worktree-issue-42-r2";

// Calls that change the issue itself; cleanup of a Task must never make any.
const ISSUE_MUTATIONS = ["addAssignees", "removeAssignees", "addLabels", "removeLabel", "updateIssue", "createIssueComment"];

const blocked = JSON.stringify({ approved: false, summary: "Есть замечания", blockers: [{ where: "src/login.ts:10", what: "wrong" }] });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

type Scenario = TestApp & { implementer: FakeAgentProcess };

describe("cancellation, return from a dead end and restoration of the issue", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  // A taken Task whose Implementer finished its first Turn: the Task is in `qa` with a QA Agent running.
  const implemented = async (setup: (testApp: TestApp) => void = () => {}): Promise<Scenario> => {
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
    return { ...testApp, implementer };
  };

  // A Task in a dead end after its single allowed QA round.
  const stuck = async (): Promise<Scenario> => {
    const s = await implemented((testApp) => testApp.index.installation.set(MAX_QA_ROUNDS_KEY, "1"));
    const qa = s.ports.driver.lastLaunch();
    qa.emit(sdkMessages.init(QA_SESSION));
    qa.emit(sdkMessages.assistantText(QA_SESSION, blocked));
    qa.emit(sdkMessages.resultSuccess(QA_SESSION, blocked));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    return s;
  };

  const issueMutations = (s: TestApp) => s.ports.github.calls.filter((call) => ISSUE_MUTATIONS.includes(call.method));
  const tasks = async (s: TestApp): Promise<TasksResponse> => (await s.request("/api/tasks")).json() as Promise<TasksResponse>;

  it("cancels a Task whose issue a human closed: Agents stopped, pull request closed, branches and worktree gone", async () => {
    const s = await implemented();
    const { github, worktree, driver, clock } = s.ports;
    expect(s.orchestrator.slots()).toEqual({ used: 1, max: 2 });

    await clock.advance(1_000);
    github.humanUpdateIssue(42, { state: "closed", stateReason: "not_planned" });
    await s.orchestrator.pollOnce();
    const cancelledAt = new Date(clock.now()).toISOString();

    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "cancelled", attempt: 1, pullNumber: 1, branch: null, worktreePath: null });
    expect(s.index.transitions.listFor(ISSUE).at(-1)).toEqual({
      id: 4,
      issueNumber: 42,
      from: "qa",
      to: "cancelled",
      reason: "issue closed without a merged pull request",
      at: cancelledAt,
    });
    expect(s.index.agents.listByIssue(ISSUE).every((agent) => agent.state === "stopped")).toBe(true);
    expect(driver.launches.every((launch) => launch.calls.some((call) => call.method === "stop"))).toBe(true);
    expect(github.pull(1)).toMatchObject({ state: "closed", merged: false });
    expect(github.deletedBranches).toEqual([BRANCH]);
    expect(worktree.worktrees(TEST_REPO_PATH)).toEqual([]);
    expect(worktree.branches(TEST_REPO_PATH)).toEqual(["main"]);
    expect(s.orchestrator.slots()).toEqual({ used: 0, max: 2 });
    expect(s.index.intents.listPending()).toEqual([]);
    // The issue itself is left as the human closed it: no comment, no label, no assignee change.
    expect(issueMutations(s).map((call) => call.method)).toEqual(["addAssignees", "removeLabel"]);
    expect(github.commentsOf(42)).toEqual([]);

    const body = await tasks(s);
    expect(body.inProgress).toEqual([]);
    expect(body.stuck).toEqual([]);
    expect(body.cancelled).toEqual([
      expect.objectContaining({
        issueNumber: 42,
        stage: "cancelled",
        reason: "issue closed without a merged pull request",
        pullUrl: "https://github.com/example/product/pull/1",
      }),
    ]);
    expect(body.cancelled[0]?.transitions.map((t) => [t.from, t.to])).toEqual([
      [null, "taken"],
      ["taken", "implement"],
      ["implement", "qa"],
      ["qa", "cancelled"],
    ]);
  });

  it("starts nothing when a cancelled issue is reopened, and takes a new attempt once the label is back", async () => {
    const s = await implemented();
    const { github, worktree, driver, clock } = s.ports;
    await clock.advance(1_000);
    github.humanUpdateIssue(42, { state: "closed", stateReason: "not_planned" });
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(ISSUE).stage).toBe("cancelled");
    const mutationsBefore = issueMutations(s).length;

    await clock.advance(1_000);
    github.humanUpdateIssue(42, { state: "open" });
    await s.orchestrator.pollOnce();
    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "cancelled", attempt: 1 });
    expect(driver.launches).toHaveLength(2);
    expect(issueMutations(s)).toHaveLength(mutationsBefore);
    expect(s.orchestrator.readyQueue()).toEqual([]);

    await clock.advance(1_000);
    github.humanSetLabels(42, ["ready-for-agent"]);
    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(ISSUE)).toMatchObject({
      stage: "implement",
      attempt: 2,
      round: 0,
      pullNumber: 2,
      branch: RETRY_BRANCH,
      worktreePath: RETRY_WORKTREE,
    });
    expect(driver.launches).toHaveLength(3);
    expect(driver.lastLaunch().launch).toMatchObject({ cwd: RETRY_WORKTREE });
    expect(driver.lastLaunch().launch.resume).toBeUndefined();
    expect(github.pull(2)).toMatchObject({ title: "WIP: Add login", state: "open", head: { ref: RETRY_BRANCH } });
    expect(worktree.worktrees(TEST_REPO_PATH).map((info) => info.path)).toEqual([RETRY_WORKTREE]);
    expect(s.index.transitions.listFor(ISSUE).slice(-2).map((t) => [t.from, t.to])).toEqual([
      ["cancelled", "taken"],
      ["taken", "implement"],
    ]);
  });

  it("does not treat an issue closed by its merged pull request as a cancellation", async () => {
    const s = await implemented();
    const { github, worktree, driver, clock } = s.ports;
    await clock.advance(1_000);
    github.humanMergePullRequest(1);
    github.humanUpdateIssue(42, { state: "closed", stateReason: "completed" });

    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "qa", branch: BRANCH, worktreePath: WORKTREE });
    expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "implement", to: "qa" });
    expect(github.pull(1)).toMatchObject({ state: "closed", merged: true });
    expect(github.deletedBranches).toEqual([]);
    expect(worktree.worktrees(TEST_REPO_PATH).map((info) => info.path)).toEqual([WORKTREE]);
    expect(driver.lastLaunch().calls.some((call) => call.method === "stop")).toBe(false);
    expect(s.index.agents.listByIssue(ISSUE).at(-1)).toMatchObject({ role: "qa", state: "running" });
  });

  it("cancels a Task in a dead end too, freeing its worktree, branch and pull request", async () => {
    const s = await stuck();
    const { github, worktree, clock } = s.ports;
    expect(worktree.worktrees(TEST_REPO_PATH).map((info) => info.path)).toEqual([WORKTREE]);

    await clock.advance(1_000);
    github.humanUpdateIssue(42, { state: "closed", stateReason: "not_planned" });
    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "cancelled", branch: null, worktreePath: null });
    expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "stuck", to: "cancelled" });
    expect(github.pull(1)).toMatchObject({ state: "closed", merged: false });
    expect(github.deletedBranches).toEqual([BRANCH]);
    expect(worktree.worktrees(TEST_REPO_PATH)).toEqual([]);
    expect(worktree.branches(TEST_REPO_PATH)).toEqual(["main"]);
  });

  it("finishes an interrupted cleanup on the next cycle", async () => {
    const s = await implemented();
    const { github, worktree, clock } = s.ports;
    const original = worktree.removeWorktree.bind(worktree);
    let failures = 0;
    worktree.removeWorktree = async (input) => {
      if (failures++ === 0) throw new Error("worktree is locked");
      return original(input);
    };

    await clock.advance(1_000);
    github.humanUpdateIssue(42, { state: "closed", stateReason: "not_planned" });
    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(ISSUE).stage).toBe("cancelled");
    expect(github.pull(1).state).toBe("closed");
    expect(worktree.worktrees(TEST_REPO_PATH).map((info) => info.path)).toEqual([WORKTREE]);
    expect(s.index.intents.listPending().map((intent) => intent.kind)).toEqual(["cleanup-workspace"]);

    await clock.advance(1_000);
    await s.orchestrator.pollOnce();

    expect(worktree.worktrees(TEST_REPO_PATH)).toEqual([]);
    expect(worktree.branches(TEST_REPO_PATH)).toEqual(["main"]);
    // The remote delete runs once more on retry; the adapter treats a missing branch as deleted.
    expect(github.deletedBranches).toEqual([BRANCH, BRANCH]);
    expect(s.index.intents.listPending()).toEqual([]);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "cancelled", branch: null, worktreePath: null });
  });

  it("returns a Task from a dead end on ready-for-agent: old pull request closed, old worktree and branch gone, fresh attempt", async () => {
    const s = await stuck();
    const { github, worktree, driver, clock } = s.ports;
    expect(github.issue(42)).toMatchObject({ labels: ["ready-for-human"], assignees: [] });
    expect(driver.launches).toHaveLength(2);

    await clock.advance(1_000);
    github.humanSetLabels(42, ["ready-for-human", "ready-for-agent"]);
    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(ISSUE)).toMatchObject({
      stage: "implement",
      attempt: 2,
      round: 0,
      pullNumber: 2,
      branch: RETRY_BRANCH,
      worktreePath: RETRY_WORKTREE,
    });
    expect(s.index.transitions.listFor(ISSUE).map((t) => [t.from, t.to])).toEqual([
      [null, "taken"],
      ["taken", "implement"],
      ["implement", "qa"],
      ["qa", "stuck"],
      ["stuck", "taken"],
      ["taken", "implement"],
    ]);
    expect(github.pull(1)).toMatchObject({ state: "closed", merged: false, title: "WIP: Add login" });
    expect(github.pull(2)).toMatchObject({ state: "open", title: "WIP: Add login", head: { ref: RETRY_BRANCH }, base: { ref: "main" } });
    expect(github.deletedBranches).toEqual([BRANCH]);
    expect(worktree.worktrees(TEST_REPO_PATH).map((info) => info.path)).toEqual([RETRY_WORKTREE]);
    expect(worktree.branches(TEST_REPO_PATH)).toEqual(["main", RETRY_BRANCH]);
    expect(github.issue(42)).toMatchObject({ labels: [], assignees: ["auto-dev-bot"] });

    expect(driver.launches).toHaveLength(3);
    const launch = driver.lastLaunch().launch;
    expect(launch.cwd).toBe(RETRY_WORKTREE);
    expect(launch.resume).toBeUndefined();
    expect(launch.prompt).toContain(RETRY_BRANCH);
    expect(s.index.agents.listByIssue(ISSUE).map((agent) => [agent.role, agent.state])).toEqual([
      ["implementer", "stopped"],
      ["qa", "stopped"],
      ["implementer", "running"],
    ]);
    // The dead-end comment stays; the return adds nothing.
    expect(github.commentsOf(42)).toHaveLength(1);
    expect(s.index.intents.listPending()).toEqual([]);
    expect(s.orchestrator.slots()).toEqual({ used: 1, max: 2 });

    const body = await tasks(s);
    expect(body.stuck).toEqual([]);
    expect(body.inProgress).toEqual([
      expect.objectContaining({ issueNumber: 42, stage: "implement", attempt: 2, pullUrl: "https://github.com/example/product/pull/2" }),
    ]);
  });

  it("restores the assignee and removes the label a human changed on a Task in progress, silently, in one cycle", async () => {
    const s = await implemented();
    const { github, driver, clock } = s.ports;
    const before = issueMutations(s).length;

    await clock.advance(1_000);
    github.humanSetAssignees(42, []);
    github.humanSetLabels(42, ["ready-for-agent", "enhancement"]);
    await s.orchestrator.pollOnce();

    expect(github.issue(42)).toMatchObject({ assignees: ["auto-dev-bot"], labels: ["enhancement"] });
    expect(issueMutations(s).slice(before)).toEqual([
      { method: "addAssignees", args: [42, ["auto-dev-bot"]] },
      { method: "removeLabel", args: [42, "ready-for-agent"] },
    ]);
    expect(github.commentsOf(42)).toEqual([]);
    expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "qa", attempt: 1 });
    expect(driver.launches).toHaveLength(2);
    expect(s.orchestrator.readyQueue()).toEqual([]);

    // A second cycle finds nothing to restore.
    await clock.advance(1_000);
    await s.orchestrator.pollOnce();
    expect(issueMutations(s)).toHaveLength(before + 2);

    // Only the assignee gone: only the assignee comes back.
    await clock.advance(1_000);
    github.humanSetAssignees(42, ["alice"]);
    await s.orchestrator.pollOnce();
    expect(github.issue(42).assignees).toEqual(["alice", "auto-dev-bot"]);
    expect(issueMutations(s).slice(before + 2)).toEqual([{ method: "addAssignees", args: [42, ["auto-dev-bot"]] }]);
  });

  it("leaves a Task in a dead end alone: the human owns its labels and assignee", async () => {
    const s = await stuck();
    const { github, clock } = s.ports;
    const before = issueMutations(s).length;

    await clock.advance(1_000);
    github.humanSetAssignees(42, ["alice"]);
    github.humanSetLabels(42, []);
    await s.orchestrator.pollOnce();

    expect(github.issue(42)).toMatchObject({ assignees: ["alice"], labels: [] });
    expect(issueMutations(s)).toHaveLength(before);
    expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
  });
});
