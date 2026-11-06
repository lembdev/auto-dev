import { afterEach, describe, expect, it } from "vitest";
import { createFakePorts, type FakePorts } from "../../src/fakes/index.js";
import type { IssueNumber } from "../../src/ids.js";
import { IN_MEMORY, openRuntimeIndex, type RuntimeIndex } from "../../src/index/runtime-index.js";
import type { Task } from "../../src/index/tasks.js";
import { createLogger } from "../../src/log.js";
import { INSTALLATION_KEYS, Orchestrator, type OrchestratorHooks } from "../../src/orchestrator/orchestrator.js";
import type { Issue } from "../../src/ports/github.js";

const MUTATING = ["addAssignees", "removeAssignees", "addLabels", "removeLabel", "updateIssue", "createIssueComment"];

type Scenario = {
  ports: FakePorts;
  index: RuntimeIndex;
  orchestrator: Orchestrator;
  mutations(): { method: string; args: unknown[] }[];
};

const log = createLogger({ level: "silent" });

const scenario = (options: { maxParallelTasks?: number; hooks?: OrchestratorHooks; index?: RuntimeIndex } = {}): Scenario => {
  const ports = createFakePorts();
  ports.worktree.seedRepo("/var/lib/auto-dev/repo");
  const index = options.index ?? openRuntimeIndex(IN_MEMORY);
  if (options.maxParallelTasks !== undefined) {
    index.installation.set(INSTALLATION_KEYS.maxParallelTasks, String(options.maxParallelTasks));
  }
  const orchestratorOptions = options.hooks ? { ports, index, log, hooks: options.hooks } : { ports, index, log };
  const orchestrator = new Orchestrator(orchestratorOptions);
  return {
    ports,
    index,
    orchestrator,
    mutations: () => ports.github.calls.filter((call) => MUTATING.includes(call.method)),
  };
};

const takenIssues = (s: Scenario): number[] => s.mutations().filter((c) => c.method === "addAssignees").map((c) => c.args[0] as number);

describe("taking Ready tasks", () => {
  const open: Scenario[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) {
      s.orchestrator.stop();
      s.index.close();
    }
  });

  it("takes Ready tasks by milestone creation order, then issue number, issues without milestone last", async () => {
    const s = scenario({ maxParallelTasks: 100 });
    open.push(s);
    const github = s.ports.github;
    const m1 = github.seedMilestone({ number: 1, title: "Эпик 1" });
    const m2 = github.seedMilestone({ number: 2, title: "Эпик 2" });
    github.seedIssue({ number: 9, labels: ["ready-for-agent"] });
    github.seedIssue({ number: 7, labels: ["ready-for-agent"], milestone: m2 });
    github.seedIssue({ number: 5, labels: ["ready-for-agent"], milestone: m1 });
    github.seedIssue({ number: 8, labels: ["ready-for-agent"], milestone: m1 });
    github.seedIssue({ number: 3, labels: ["ready-for-agent"], milestone: m2 });
    github.seedIssue({ number: 2, labels: ["ready-for-agent"] });

    await s.orchestrator.pollOnce();

    expect(takenIssues(s)).toEqual([5, 8, 3, 7, 2, 9]);
  });

  it("skips issues that are not Ready: triage labels, blockers, assignees, Epic and Spec types, closed, pull requests", async () => {
    const s = scenario({ maxParallelTasks: 100 });
    open.push(s);
    const github = s.ports.github;
    github.seedIssue({ number: 1, labels: ["ready-for-agent", "needs-triage"] });
    github.seedIssue({ number: 2, labels: ["ready-for-agent", "needs-info"] });
    github.seedIssue({ number: 3, labels: ["ready-for-agent", "wontfix"] });
    github.seedIssue({ number: 4, labels: ["ready-for-agent"], dependencies: { blockedBy: 1, blocking: 0, totalBlockedBy: 2, totalBlocking: 0 } });
    github.seedIssue({ number: 5, labels: ["ready-for-agent"], assignees: ["alice"] });
    github.seedIssue({ number: 6, labels: ["ready-for-agent"], type: "Epic" });
    github.seedIssue({ number: 7, labels: ["ready-for-agent"], type: "Spec" });
    github.seedIssue({ number: 8, labels: ["ready-for-agent"], state: "closed" });
    github.seedIssue({ number: 9, labels: ["ready-for-agent"], isPullRequest: true });
    github.seedIssue({ number: 10, labels: [] });
    github.seedIssue({ number: 11, labels: ["ready-for-agent"], type: "Task" });
    github.seedIssue({ number: 12, labels: ["ready-for-agent"], type: "Bug" });
    github.seedIssue({ number: 13, labels: ["ready-for-agent"], dependencies: { blockedBy: 0, blocking: 0, totalBlockedBy: 3, totalBlocking: 0 } });

    await s.orchestrator.pollOnce();

    expect(takenIssues(s)).toEqual([11, 12, 13]);
    expect(s.orchestrator.readyQueue()).toEqual([]);
  });

  it("takes with exactly two mutating calls and records the task and its transition", async () => {
    const afterTake: { task: Task; issue: Issue }[] = [];
    const s = scenario({
      hooks: {
        afterTake: async (task, issue) => {
          afterTake.push({ task, issue });
        },
      },
    });
    open.push(s);
    const github = s.ports.github;
    const milestone = github.seedMilestone({ number: 4, title: "Эпик 4" });
    github.seedIssue({ number: 42, title: "Add login", labels: ["ready-for-agent", "enhancement"], milestone });
    await s.ports.clock.advance(1_000);

    await s.orchestrator.pollOnce();

    expect(s.mutations()).toEqual([
      { method: "addAssignees", args: [42, ["auto-dev-bot"]] },
      { method: "removeLabel", args: [42, "ready-for-agent"] },
    ]);
    expect(github.issue(42)).toMatchObject({ assignees: ["auto-dev-bot"], labels: ["enhancement"] });

    const takenAt = new Date(s.ports.clock.now()).toISOString();
    expect(s.index.tasks.get(42 as IssueNumber)).toEqual({
      issueNumber: 42,
      title: "Add login",
      milestone: { number: 4, title: "Эпик 4" },
      stage: "implement",
      round: 0,
      attempt: 1,
      pullNumber: 1,
      branch: "worktree-issue-42",
      worktreePath: "/var/lib/auto-dev/repo/.claude/worktrees/issue-42",
      takenAt,
      updatedAt: takenAt,
    });
    expect(s.index.transitions.listFor(42 as IssueNumber)).toEqual([
      { id: 1, issueNumber: 42, from: null, to: "taken", reason: null, at: takenAt },
      { id: 2, issueNumber: 42, from: "taken", to: "implement", reason: "implementer started", at: takenAt },
    ]);
    expect(afterTake).toHaveLength(1);
    expect(afterTake[0]?.task).toMatchObject({ issueNumber: 42, pullNumber: 1, branch: "worktree-issue-42" });
    expect(afterTake[0]?.issue.title).toBe("Add login");

    // A second cycle changes nothing: the issue is ours now.
    await s.orchestrator.pollOnce();
    expect(s.mutations()).toHaveLength(2);
  });

  it("does not take beyond max_parallel_tasks and picks the next in order when a slot frees up", async () => {
    const s = scenario();
    open.push(s);
    const github = s.ports.github;
    github.seedIssue({ number: 1, labels: ["ready-for-agent"] });
    github.seedIssue({ number: 2, labels: ["ready-for-agent"] });
    github.seedIssue({ number: 3, labels: ["ready-for-agent"] });
    github.seedIssue({ number: 4, labels: ["ready-for-agent"] });

    await s.orchestrator.start();
    expect(takenIssues(s)).toEqual([1, 2]);
    expect(s.orchestrator.slots()).toEqual({ used: 2, max: 2 });
    expect(s.orchestrator.readyQueue().map((issue) => issue.number)).toEqual([3, 4]);

    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([1, 2]);

    s.orchestrator.transition(2 as IssueNumber, "done");
    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([1, 2, 3]);
    expect(s.orchestrator.slots()).toEqual({ used: 2, max: 2 });

    s.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, "3");
    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([1, 2, 3, 4]);
  });

  it("keeps the active Task out of the queue even if a human puts the label back", async () => {
    const s = scenario({ maxParallelTasks: 1 });
    open.push(s);
    const github = s.ports.github;
    github.seedIssue({ number: 1, labels: ["ready-for-agent"] });
    await s.orchestrator.start();
    expect(takenIssues(s)).toEqual([1]);

    await s.ports.clock.advance(1_000);
    github.humanSetLabels(1, ["ready-for-agent"]);
    s.orchestrator.transition(1 as IssueNumber, "implement");
    await s.ports.clock.advance(15_000);

    expect(takenIssues(s)).toEqual([1]);
    expect(s.orchestrator.readyQueue()).toEqual([]);
  });

  it("retries an issue it half-took: assignee set but the label still on", async () => {
    const s = scenario();
    open.push(s);
    const github = s.ports.github;
    github.seedIssue({ number: 1, labels: ["ready-for-agent"], assignees: ["auto-dev-bot"] });
    await s.orchestrator.pollOnce();
    expect(s.mutations().map((call) => call.method)).toEqual(["addAssignees", "removeLabel"]);
    expect(s.index.tasks.find(1 as IssueNumber)?.stage).toBe("implement");
  });

  it("reacts to issues that become Ready after start", async () => {
    const s = scenario();
    open.push(s);
    const github = s.ports.github;
    github.seedIssue({ number: 1, labels: [] });
    await s.orchestrator.start();
    expect(takenIssues(s)).toEqual([]);

    await s.ports.clock.advance(1_000);
    github.humanSetLabels(1, ["ready-for-agent"]);
    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([1]);

    await s.ports.clock.advance(1_000);
    github.seedIssue({ number: 2, labels: ["ready-for-agent"], dependencies: { blockedBy: 1, blocking: 0, totalBlockedBy: 1, totalBlocking: 0 } });
    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([1]);

    await s.ports.clock.advance(1_000);
    github.humanSetDependencies(2, { blockedBy: 0 });
    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([1, 2]);
  });

  it("takes a blocked issue once its blocker is closed, though GitHub leaves the blocked issue untouched", async () => {
    const s = scenario();
    open.push(s);
    const github = s.ports.github;
    github.seedIssue({ number: 1, labels: [] });
    github.seedIssue({ number: 2, labels: ["ready-for-agent"], dependencies: { blockedBy: 1, blocking: 0, totalBlockedBy: 1, totalBlocking: 0 } });
    await s.orchestrator.start();
    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([]);
    // Other activity moves the poll cursor past the blocked issue.
    await s.ports.clock.advance(1_000);
    github.seedIssue({ number: 3, labels: [] });
    await s.ports.clock.advance(15_000);

    await s.ports.clock.advance(1_000);
    github.humanCloseBlocker(1, 2);
    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([2]);
  });

  it("survives a failing poll and keeps polling", async () => {
    const s = scenario();
    open.push(s);
    const github = s.ports.github;
    const original = github.pollIssues.bind(github);
    let failures = 0;
    github.pollIssues = async (query) => {
      if (failures++ === 0) throw new Error("rate limited");
      return original(query);
    };
    github.seedIssue({ number: 1, labels: ["ready-for-agent"] });
    await s.orchestrator.start();
    expect(takenIssues(s)).toEqual([]);
    await s.ports.clock.advance(15_000);
    expect(takenIssues(s)).toEqual([1]);
  });

  it("records the Task and the take intent before touching GitHub and finishes a half-done take on the next cycle", async () => {
    const s = scenario();
    open.push(s);
    const github = s.ports.github;
    github.seedIssue({ number: 4, title: "Add search", labels: ["ready-for-agent"] });
    const seen: { stage: string | undefined; pending: string[] }[] = [];
    const originalAssign = github.addAssignees.bind(github);
    github.addAssignees = async (...args) => {
      seen.push({ stage: s.index.tasks.find(4 as IssueNumber)?.stage, pending: s.index.intents.listPending().map((intent) => intent.kind) });
      return originalAssign(...args);
    };
    const originalRemove = github.removeLabel.bind(github);
    github.removeLabel = async () => {
      throw new Error("connection reset");
    };

    await s.orchestrator.pollOnce();

    expect(seen).toEqual([{ stage: "taken", pending: ["take"] }]);
    expect(github.issue(4)).toMatchObject({ assignees: ["auto-dev-bot"], labels: ["ready-for-agent"] });
    expect(s.index.tasks.get(4 as IssueNumber)).toMatchObject({ stage: "taken", pullNumber: null });
    expect(s.index.intents.listPending().map((intent) => intent.kind)).toEqual(["take"]);
    expect(s.ports.driver.launches).toHaveLength(0);

    github.removeLabel = originalRemove;
    await s.orchestrator.pollOnce();

    expect(github.issue(4)).toMatchObject({ assignees: ["auto-dev-bot"], labels: [] });
    expect(s.index.intents.listPending()).toEqual([]);
    expect(s.index.tasks.get(4 as IssueNumber)).toMatchObject({ stage: "implement", attempt: 1, pullNumber: 1 });
    expect(s.index.transitions.listFor(4 as IssueNumber).map((t) => t.to)).toEqual(["taken", "implement"]);
    expect(s.ports.driver.launches).toHaveLength(1);
  });

  it("finishes a take cut short by a restart: the new process completes the intent and prepares the workspace", async () => {
    const first = scenario();
    const github = first.ports.github;
    github.seedIssue({ number: 4, labels: ["ready-for-agent"] });
    const originalAssign = github.addAssignees.bind(github);
    github.addAssignees = async () => {
      throw new Error("process died");
    };
    await first.orchestrator.pollOnce();
    expect(first.index.tasks.get(4 as IssueNumber).stage).toBe("taken");
    first.orchestrator.stop();

    github.addAssignees = originalAssign;
    const second = new Orchestrator({ ports: first.ports, index: first.index, log });
    open.push({ ...first, orchestrator: second });
    await second.pollOnce();

    expect(github.issue(4)).toMatchObject({ assignees: ["auto-dev-bot"], labels: [] });
    expect(first.index.tasks.get(4 as IssueNumber)).toMatchObject({ stage: "implement", attempt: 1, pullNumber: 1 });
    expect(first.ports.driver.launches).toHaveLength(1);
  });
});
