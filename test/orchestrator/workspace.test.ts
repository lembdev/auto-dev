import { afterEach, describe, expect, it } from "vitest";
import { createFakePorts, type FakePorts } from "../../src/fakes/index.js";
import type { IssueNumber } from "../../src/ids.js";
import { IN_MEMORY, openRuntimeIndex, type RuntimeIndex } from "../../src/index/runtime-index.js";
import { createLogger } from "../../src/log.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";

const REPO = "/var/lib/auto-dev/repo";
const log = createLogger({ level: "silent" });

type Scenario = { ports: FakePorts; index: RuntimeIndex; orchestrator: Orchestrator };

const scenario = (options: { index?: RuntimeIndex; ports?: FakePorts } = {}): Scenario => {
  const ports = options.ports ?? createFakePorts();
  if (!options.ports) ports.worktree.seedRepo(REPO);
  const index = options.index ?? openRuntimeIndex(IN_MEMORY);
  const orchestrator = new Orchestrator({ ports, index, log, product: { repoPath: REPO } });
  return { ports, index, orchestrator };
};

describe("workspace of a taken Task", () => {
  const open: Scenario[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) {
      s.orchestrator.stop();
      s.index.close();
    }
  });

  it("creates the worktree and branch from origin/main, pushes and opens a WIP pull request that closes the issue", async () => {
    const s = scenario();
    open.push(s);
    const { github, worktree } = s.ports;
    github.seedIssue({ number: 42, title: "Add login", labels: ["ready-for-agent"] });

    await s.orchestrator.pollOnce();

    const path = `${REPO}/.claude/worktrees/issue-42`;
    expect(worktree.log.of("addWorktree").map((call) => call.args[0])).toEqual([
      { repoPath: REPO, path, branch: "worktree-issue-42", base: "origin/main" },
    ]);
    expect(worktree.worktrees(REPO)).toEqual([{ path, branch: "worktree-issue-42", head: "sha-worktree-issue-42" }]);
    expect(worktree.pushes).toEqual([{ cwd: path, branch: "worktree-issue-42" }]);
    expect(github.calls.filter((call) => call.method === "createPullRequest")).toEqual([
      {
        method: "createPullRequest",
        args: [{ title: "WIP: Add login", body: "Closes #42\n\n<!-- auto-dev -->", head: "worktree-issue-42", base: "main" }],
      },
    ]);
    const pull = github.pull(1);
    expect(pull).toMatchObject({ title: "WIP: Add login", head: { ref: "worktree-issue-42" }, base: { ref: "main" }, state: "open" });
    expect(s.index.tasks.get(42 as IssueNumber)).toMatchObject({
      stage: "taken",
      attempt: 1,
      branch: "worktree-issue-42",
      worktreePath: path,
      pullNumber: 1,
    });
    expect(s.index.intents.listPending()).toEqual([]);
    expect(s.index.intents.listFor(42 as IssueNumber)).toEqual([
      expect.objectContaining({
        kind: "prepare-workspace",
        state: "done",
        payload: { branch: "worktree-issue-42", path, base: "main", title: "Add login" },
        result: { pullNumber: 1 },
      }),
    ]);
  });

  it("clones the Product first when the data directory has no clone yet", async () => {
    const ports = createFakePorts();
    const index = openRuntimeIndex(IN_MEMORY);
    const orchestrator = new Orchestrator({
      ports,
      index,
      log,
      product: { repoPath: REPO, cloneUrl: "https://github.com/example/product.git" },
    });
    open.push({ ports, index, orchestrator });
    ports.github.seedIssue({ number: 1, labels: ["ready-for-agent"] });

    await orchestrator.pollOnce();

    expect(ports.worktree.log.of("clone").map((call) => call.args[0])).toEqual([
      { url: "https://github.com/example/product.git", path: REPO },
    ]);
    expect(ports.worktree.worktrees(REPO).map((info) => info.branch)).toEqual(["worktree-issue-1"]);

    await orchestrator.pollOnce();
    expect(ports.worktree.log.of("clone")).toHaveLength(1);
  });

  it("suffixes the worktree and branch with the attempt when the same issue is taken again", async () => {
    const s = scenario();
    open.push(s);
    const { github, worktree } = s.ports;
    github.seedIssue({ number: 7, title: "Flaky", labels: ["ready-for-agent"] });
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(7 as IssueNumber)).toMatchObject({ attempt: 1, branch: "worktree-issue-7", pullNumber: 1 });

    // A dead end: the human puts the label back and takes the assignee off, as the return path does.
    s.orchestrator.transition(7 as IssueNumber, "stuck", "QA failed twice");
    await s.ports.clock.advance(1_000);
    github.humanSetAssignees(7, []);
    github.humanSetLabels(7, ["ready-for-agent"]);
    await s.orchestrator.pollOnce();

    const path = `${REPO}/.claude/worktrees/issue-7-r2`;
    expect(worktree.worktrees(REPO).map((info) => info.path)).toEqual([`${REPO}/.claude/worktrees/issue-7`, path]);
    expect(worktree.pushes.at(-1)).toEqual({ cwd: path, branch: "worktree-issue-7-r2" });
    expect(github.pull(2)).toMatchObject({ title: "WIP: Flaky", head: { ref: "worktree-issue-7-r2" } });
    expect(s.index.tasks.get(7 as IssueNumber)).toMatchObject({
      stage: "taken",
      attempt: 2,
      round: 0,
      branch: "worktree-issue-7-r2",
      worktreePath: path,
      pullNumber: 2,
    });
    expect(s.index.transitions.listFor(7 as IssueNumber).map((t) => [t.from, t.to])).toEqual([
      [null, "taken"],
      ["taken", "stuck"],
      ["stuck", "taken"],
    ]);
  });

  it("records every external action as an intent before doing it and marks it done after", async () => {
    const s = scenario();
    open.push(s);
    const { github, worktree } = s.ports;
    github.seedIssue({ number: 3, labels: ["ready-for-agent"] });
    const seen: { method: string; pending: string[] }[] = [];
    const snapshot = (method: string) =>
      seen.push({ method, pending: s.index.intents.listPending().map((intent) => intent.kind) });
    const originalAdd = worktree.addWorktree.bind(worktree);
    worktree.addWorktree = async (input) => {
      snapshot("addWorktree");
      return originalAdd(input);
    };
    const originalPush = worktree.push.bind(worktree);
    worktree.push = async (input) => {
      snapshot("push");
      return originalPush(input);
    };
    const originalCreate = github.createPullRequest.bind(github);
    github.createPullRequest = async (input) => {
      snapshot("createPullRequest");
      return originalCreate(input);
    };

    await s.orchestrator.pollOnce();

    expect(seen).toEqual([
      { method: "addWorktree", pending: ["prepare-workspace"] },
      { method: "push", pending: ["prepare-workspace"] },
      { method: "createPullRequest", pending: ["prepare-workspace"] },
    ]);
    expect(s.index.intents.listPending()).toEqual([]);
  });

  it("finishes the intent exactly once after a crash between creating the PR and marking it done", async () => {
    const first = scenario();
    const { github } = first.ports;
    github.seedIssue({ number: 5, title: "Crashy", labels: ["ready-for-agent"] });
    const originalCreate = github.createPullRequest.bind(github);
    github.createPullRequest = async (input) => {
      await originalCreate(input);
      throw new Error("process died");
    };

    await first.orchestrator.pollOnce();

    expect(github.pull(1)).toMatchObject({ title: "WIP: Crashy", state: "open" });
    expect(first.index.tasks.get(5 as IssueNumber).pullNumber).toBeNull();
    expect(first.index.intents.listPending().map((intent) => intent.kind)).toEqual(["prepare-workspace"]);
    first.orchestrator.stop();

    // Restart on the same index and the same GitHub state.
    github.createPullRequest = originalCreate;
    const second = scenario({ index: first.index, ports: first.ports });
    open.push(second);
    await second.orchestrator.pollOnce();

    expect(github.calls.filter((call) => call.method === "createPullRequest")).toHaveLength(1);
    expect(await github.listPullRequests({ state: "all" })).toHaveLength(1);
    expect(second.index.tasks.get(5 as IssueNumber)).toMatchObject({ pullNumber: 1, branch: "worktree-issue-5" });
    expect(second.index.intents.listPending()).toEqual([]);
  });

  it("finishes the intent after a crash right after the worktree without a second worktree, branch or push", async () => {
    const first = scenario();
    const { worktree } = first.ports;
    first.ports.github.seedIssue({ number: 6, labels: ["ready-for-agent"] });
    const originalAdd = worktree.addWorktree.bind(worktree);
    worktree.addWorktree = async (input) => {
      await originalAdd(input);
      throw new Error("process died");
    };
    await first.orchestrator.pollOnce();
    expect(first.index.intents.listPending().map((intent) => intent.kind)).toEqual(["prepare-workspace"]);
    expect(first.index.tasks.get(6 as IssueNumber)).toMatchObject({ branch: null, worktreePath: null, pullNumber: null });
    first.orchestrator.stop();

    worktree.addWorktree = originalAdd;
    const second = scenario({ index: first.index, ports: first.ports });
    open.push(second);
    await second.orchestrator.pollOnce();

    expect(worktree.log.of("addWorktree")).toHaveLength(1);
    expect(worktree.worktrees(REPO)).toHaveLength(1);
    expect(worktree.pushes).toEqual([{ cwd: `${REPO}/.claude/worktrees/issue-6`, branch: "worktree-issue-6" }]);
    expect(second.index.tasks.get(6 as IssueNumber)).toMatchObject({
      branch: "worktree-issue-6",
      worktreePath: `${REPO}/.claude/worktrees/issue-6`,
      pullNumber: 1,
    });
    expect(second.index.intents.listPending()).toEqual([]);
  });

  it("keeps the Task taken and retries the pending intent on the next cycle when git fails", async () => {
    const s = scenario();
    open.push(s);
    const { worktree, github } = s.ports;
    github.seedIssue({ number: 8, labels: ["ready-for-agent"] });
    const originalPush = worktree.push.bind(worktree);
    let failures = 0;
    worktree.push = async (input) => {
      if (failures++ === 0) throw new Error("remote hung up");
      return originalPush(input);
    };

    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(8 as IssueNumber)).toMatchObject({ stage: "taken", branch: "worktree-issue-8", pullNumber: null });
    expect(s.index.intents.listPending().map((intent) => intent.kind)).toEqual(["prepare-workspace"]);

    await s.orchestrator.pollOnce();
    expect(worktree.pushes).toHaveLength(1);
    expect(s.index.tasks.get(8 as IssueNumber).pullNumber).toBe(1);
    expect(s.index.intents.listPending()).toEqual([]);
  });
});
