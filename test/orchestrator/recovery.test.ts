import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, Pid, SessionId, ToolUseId } from "../../src/ids.js";
import { INSTALLATION_KEYS, Orchestrator } from "../../src/orchestrator/orchestrator.js";
import {
  CONTINUE_PROMPT,
  FOREIGN_SWEEP_INTERVAL_MS,
  HANG_TIMEOUT_MS,
  MERGED_WHILE_DOWN_REASON,
  ORPHAN_GRACE_MS,
  hungReason,
  resumeFailedReason,
} from "../../src/orchestrator/recovery.js";
import type { TasksResponse } from "../../src/server/app.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const SECOND_SESSION = "22222222-2222-4222-8222-222222222222" as SessionId;
const ISSUE = 42 as IssueNumber;
const WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42`;
const BRANCH = "worktree-issue-42";
const CALL = { toolUseId: "toolu_01" as ToolUseId, question: "Which colour?", options: undefined };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const ISSUE_MUTATIONS = ["addAssignees", "removeAssignees", "addLabels", "removeLabel", "updateIssue", "createIssueComment"];

type Scenario = TestApp & { implementer: FakeAgentProcess; restart(): Promise<Orchestrator> };

describe("restart of the Orchestrator", () => {
  const open: TestApp[] = [];
  const restarted: Orchestrator[] = [];
  afterEach(async () => {
    for (const orchestrator of restarted.splice(0)) await orchestrator.shutdown();
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  // A taken Task whose Implementer is in the middle of its first Turn; the restart is a new Orchestrator
  // on the same index and fakes, polled once with the clock moved past the grace period of orphans.
  const working = async (setup: (testApp: TestApp) => void = () => {}): Promise<Scenario> => {
    const testApp = createTestApp();
    open.push(testApp);
    setup(testApp);
    const { github, driver } = testApp.ports;
    github.seedIssue({ number: 42, title: "Add login", body: "A login form.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const implementer = driver.lastLaunch();
    implementer.emit(sdkMessages.init(SESSION));
    await flush();
    const restart = async (): Promise<Orchestrator> => {
      const next = new Orchestrator({ ports: testApp.ports, index: testApp.index, log: testApp.log, product: { repoPath: TEST_REPO_PATH } });
      restarted.push(next);
      await pollThroughGrace(next, testApp);
      return next;
    };
    return { ...testApp, implementer, restart };
  };

  // The first cycle after a start sleeps once (through the clock) between SIGTERM and SIGKILL.
  const pollThroughGrace = async (orchestrator: Orchestrator, testApp: TestApp): Promise<void> => {
    const cycle = orchestrator.pollOnce();
    await flush();
    await testApp.ports.clock.advance(ORPHAN_GRACE_MS);
    await cycle;
  };

  // The previous Orchestrator simply disappears: its rows keep the PIDs, its fake processes stay in the table.
  const crash = (s: Scenario): void => {
    const { processes } = s.ports;
    for (const agent of s.index.agents.list()) {
      if (agent.pid !== null) processes.spawn({ pid: agent.pid, command: `claude --resume ${agent.sessionId ?? ""}` });
    }
    s.orchestrator.stop();
  };

  const signalsOf = (s: TestApp, pid: number): string[] => s.ports.processes.signals.filter((record) => record.pid === pid).map((record) => record.signal);
  const issueMutations = (s: TestApp) => s.ports.github.calls.filter((call) => ISSUE_MUTATIONS.includes(call.method));
  const tasks = async (s: TestApp): Promise<TasksResponse> => (await s.request("/api/tasks")).json() as Promise<TasksResponse>;

  describe("processes", () => {
    it("terminates the orphaned PIDs of the index and the foreign claude processes of the installation user, SIGKILL after the pause for a stubborn one", async () => {
      const s = await working();
      const { processes } = s.ports;
      const orphan = s.index.agents.listByIssue(ISSUE)[0]!;
      expect(orphan).toMatchObject({ state: "running", pid: 1000 });
      crash(s);
      processes.spawn({ pid: 5000 as Pid, command: "claude -p 'left behind'", ignoresSigterm: true });
      processes.spawn({ pid: 5001 as Pid, parentPid: 5000 as Pid, command: "node ask-human-mcp.js" });
      processes.spawn({ pid: 6000 as Pid, command: "claude", user: "alice" });
      processes.spawn({ pid: 7000 as Pid, command: "node dist/main.js" });

      await s.restart();

      expect(signalsOf(s, 1000)).toEqual(["SIGTERM"]);
      expect(signalsOf(s, 5000)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(signalsOf(s, 5001)).toEqual([]);
      expect(signalsOf(s, 6000)).toEqual([]);
      expect(signalsOf(s, 7000)).toEqual([]);
      expect(await processes.list({})).toEqual([
        expect.objectContaining({ pid: 5001 }),
        expect.objectContaining({ pid: 6000 }),
        expect.objectContaining({ pid: 7000 }),
      ]);
      // The resumed process got a new PID; the orphan's is gone from the row.
      expect(s.index.agents.get(orphan.id)).toMatchObject({ state: "running", pid: 1001, sessionId: SESSION });
    });

    it("waits through the grace period before SIGKILL instead of killing right away", async () => {
      const s = await working();
      crash(s);
      s.ports.processes.spawn({ pid: 5000 as Pid, command: "claude", ignoresSigterm: true });
      const next = new Orchestrator({ ports: s.ports, index: s.index, log: s.log, product: { repoPath: TEST_REPO_PATH } });
      restarted.push(next);
      const cycle = next.pollOnce();
      await flush();
      expect(signalsOf(s, 5000)).toEqual(["SIGTERM"]);
      await s.ports.clock.advance(ORPHAN_GRACE_MS - 1);
      expect(signalsOf(s, 5000)).toEqual(["SIGTERM"]);
      await s.ports.clock.advance(1);
      await cycle;
      expect(signalsOf(s, 5000)).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("leaves foreign processes alone when not running as the installation user", async () => {
      const s = await working();
      crash(s);
      s.ports.processes.user = "developer";
      s.ports.processes.spawn({ pid: 5000 as Pid, command: "claude", user: "developer" });
      await s.restart();
      expect(signalsOf(s, 5000)).toEqual([]);
      expect(signalsOf(s, 1000)).toEqual(["SIGTERM"]);
    });

    it("sweeps foreign claude processes again every hour, sparing its own live Agents", async () => {
      const s = await working();
      const { processes, clock } = s.ports;
      processes.spawn({ pid: 1000 as Pid, command: "claude --resume" });
      processes.spawn({ pid: 1500 as Pid, parentPid: 1000 as Pid, command: "node ask-human-mcp.js claude" });
      expect(processes.signals).toEqual([]);

      await clock.advance(FOREIGN_SWEEP_INTERVAL_MS - 1);
      processes.spawn({ pid: 5000 as Pid, command: "claude -p 'left behind'" });
      await clock.advance(1 + ORPHAN_GRACE_MS);

      expect(signalsOf(s, 5000)).toEqual(["SIGTERM"]);
      expect(signalsOf(s, 1000)).toEqual([]);
      expect(signalsOf(s, 1500)).toEqual([]);
      expect(s.index.agents.listByIssue(ISSUE)[0]).toMatchObject({ state: "running", pid: 1000 });

      processes.spawn({ pid: 5002 as Pid, command: "claude", ignoresSigterm: true });
      await clock.advance(FOREIGN_SWEEP_INTERVAL_MS + ORPHAN_GRACE_MS);
      expect(signalsOf(s, 5002)).toEqual(["SIGTERM", "SIGKILL"]);

      s.orchestrator.stop();
      processes.spawn({ pid: 5003 as Pid, command: "claude" });
      await clock.advance(FOREIGN_SWEEP_INTERVAL_MS + ORPHAN_GRACE_MS);
      expect(signalsOf(s, 5003)).toEqual([]);
    });
  });

  describe("the index against GitHub", () => {
    // Changes made while the Orchestrator was down and the poll cursor already past them: only the start
    // check can see them.
    const whileDown = (s: Scenario, change: () => void): void => {
      crash(s);
      change();
      s.index.installation.set(INSTALLATION_KEYS.issuesSince, new Date(s.ports.clock.now() + 60_000).toISOString());
    };

    it("cancels a Task whose issue was closed without a merge while down", async () => {
      const s = await working();
      const { github, worktree, driver } = s.ports;
      whileDown(s, () => github.humanUpdateIssue(42, { state: "closed", stateReason: "not_planned" }));

      await s.restart();

      expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "cancelled", branch: null, worktreePath: null });
      expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "implement", to: "cancelled", reason: "issue closed without a merged pull request" });
      expect(github.pull(1)).toMatchObject({ state: "closed", merged: false });
      expect(github.deletedBranches).toEqual([BRANCH]);
      expect(worktree.worktrees(TEST_REPO_PATH)).toEqual([]);
      expect(driver.launches).toHaveLength(1);
      expect(s.index.agents.listByIssue(ISSUE)[0]).toMatchObject({ state: "stopped", pid: null });
      expect(issueMutations(s).map((call) => call.method)).toEqual(["addAssignees", "removeLabel"]);
    });

    it("finishes a Task whose pull request was merged by hand while down: issue closed, final comment, worktree gone, done", async () => {
      const s = await working();
      const { github, worktree, driver } = s.ports;
      whileDown(s, () => github.humanMergePullRequest(1));

      await s.restart();

      expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "done", worktreePath: null });
      expect(s.index.transitions.listFor(ISSUE).slice(-2)).toEqual([
        expect.objectContaining({ from: "implement", to: "merge", reason: MERGED_WHILE_DOWN_REASON }),
        expect.objectContaining({ from: "merge", to: "done", reason: "pull request merged" }),
      ]);
      expect(github.issue(42)).toMatchObject({ state: "closed", stateReason: "completed" });
      expect(github.commentsOf(42)).toHaveLength(1);
      expect(worktree.worktrees(TEST_REPO_PATH)).toEqual([]);
      expect(worktree.branches(TEST_REPO_PATH)).toEqual(["main"]);
      expect(driver.launches).toHaveLength(1);
      expect(s.orchestrator.slots().used).toBe(0);
    });

    it("restores the assignee and removes ready-for-agent changed while down, keeps the Stage of the index and resumes the Turn", async () => {
      const s = await working();
      const { github, driver } = s.ports;
      const before = issueMutations(s).length;
      whileDown(s, () => {
        github.humanSetAssignees(42, ["alice"]);
        github.humanSetLabels(42, ["ready-for-agent", "bug"]);
      });

      const next = await s.restart();

      expect(github.issue(42)).toMatchObject({ assignees: ["alice", "auto-dev-bot"], labels: ["bug"] });
      expect(issueMutations(s).slice(before)).toEqual([
        { method: "addAssignees", args: [42, ["auto-dev-bot"]] },
        { method: "removeLabel", args: [42, "ready-for-agent"] },
      ]);
      expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "implement", attempt: 1 });
      expect(next.readyQueue()).toEqual([]);
      expect(driver.launches).toHaveLength(2);
      expect(driver.lastLaunch().launch).toMatchObject({ resume: SESSION, resumeInterruptedTurn: true });
    });

    it("keeps a Task in a dead end as the human left it", async () => {
      const s = await working();
      const { github } = s.ports;
      s.orchestrator.transition(ISSUE, "stuck", "test");
      await s.orchestrator.agents.stop(s.index.agents.listByIssue(ISSUE)[0]!.id);
      const before = issueMutations(s).length;
      whileDown(s, () => github.humanSetAssignees(42, []));

      await s.restart();

      expect(issueMutations(s)).toHaveLength(before);
      expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
      expect(s.ports.driver.launches).toHaveLength(1);
    });
  });

  describe("resume", () => {
    it("resumes the Turn cut short by a crash with CLAUDE_CODE_RESUME_INTERRUPTED_TURN and the ask_human handler; a waiting Agent stays waiting", async () => {
      const s = await working();
      const { github, driver } = s.ports;
      github.seedIssue({ number: 43, title: "Add logout", labels: ["ready-for-agent"] });
      await s.orchestrator.pollOnce();
      const second = driver.lastLaunch();
      second.emit(sdkMessages.init(SECOND_SESSION));
      second.emit(
        sdkMessages.resultSuccess(SECOND_SESSION, "", {
          stop_reason: "tool_deferred",
          terminal_reason: "tool_deferred",
          deferred_tool_use: { id: "toolu_01", name: "mcp__human__ask_human", input: { question: "Which colour?" } },
        }),
      );
      second.end();
      await flush();
      expect(s.index.agents.list().map((agent) => [agent.issueNumber, agent.state])).toEqual([
        [42, "running"],
        [43, "waiting"],
      ]);
      crash(s);

      await s.restart();

      expect(driver.launches).toHaveLength(3);
      const resumed = driver.lastLaunch();
      expect(resumed.launch).toMatchObject({ cwd: WORKTREE, resume: SESSION, resumeInterruptedTurn: true });
      expect(resumed.launch.prompt).toBeUndefined();
      expect(resumed.launch.onAskHuman).toBeDefined();
      expect(await resumed.askHuman(CALL)).toEqual({ kind: "defer" });
      expect(s.index.agents.list().map((agent) => [agent.issueNumber, agent.state, agent.pid])).toEqual([
        [42, "running", 1002],
        [43, "waiting", null],
      ]);
      expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
    });

    it("resumes the Turns running at a graceful shutdown too", async () => {
      const s = await working();
      const { driver } = s.ports;
      await s.orchestrator.shutdown();
      expect(s.index.agents.listByIssue(ISSUE)[0]).toMatchObject({ state: "stopped", pid: null });

      await s.restart();

      expect(driver.launches).toHaveLength(2);
      expect(driver.lastLaunch().launch).toMatchObject({ resume: SESSION, resumeInterruptedTurn: true });
    });

    it("does not resume an Agent whose Turn had finished before the crash; the next message resumes it", async () => {
      const s = await working();
      const { driver } = s.ports;
      s.implementer.emit(sdkMessages.resultSuccess(SESSION, "done"));
      await flush();
      expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("idle");
      expect(s.index.tasks.get(ISSUE).stage).toBe("qa");
      crash(s);

      const next = await s.restart();

      // The restart started only a fresh QA round; the Implementer waits for the blockers.
      expect(driver.launches).toHaveLength(3);
      expect(driver.lastLaunch().launch.resume).toBeUndefined();
      expect(s.index.agents.listByIssue(ISSUE).map((agent) => [agent.role, agent.state])).toEqual([
        ["implementer", "stopped"],
        ["qa", "stopped"],
        ["qa", "running"],
      ]);
      await next.implementation.send(ISSUE, "blockers");
      expect(driver.lastLaunch().launch).toMatchObject({ resume: SESSION, prompt: "blockers" });
    });

    it("starts a fresh QA round after a restart instead of resuming the old QA Agent", async () => {
      const s = await working();
      const { driver } = s.ports;
      s.implementer.emit(sdkMessages.resultSuccess(SESSION, "done"));
      await flush();
      const qa = driver.lastLaunch();
      qa.emit(sdkMessages.init(SECOND_SESSION));
      await flush();
      crash(s);

      await s.restart();

      expect(driver.launches).toHaveLength(3);
      expect(driver.lastLaunch().launch.resume).toBeUndefined();
      expect(s.index.agents.listByIssue(ISSUE).map((agent) => [agent.role, agent.state])).toEqual([
        ["implementer", "stopped"],
        ["qa", "stopped"],
        ["qa", "running"],
      ]);
      expect(signalsOf(s, 1001)).toEqual(["SIGTERM"]);
    });

    it("waits for new Turns to be allowed before resuming", async () => {
      const s = await working();
      const { driver } = s.ports;
      crash(s);
      s.orchestrator.installation.pause("human", "lunch");

      const next = await s.restart();
      expect(driver.launches).toHaveLength(1);
      expect(s.index.agents.listByIssue(ISSUE)[0]).toMatchObject({ state: "stopped" });

      next.installation.unpause();
      await next.pollOnce();
      expect(driver.launches).toHaveLength(2);
      expect(driver.lastLaunch().launch).toMatchObject({ resume: SESSION, resumeInterruptedTurn: true });
    });

    it("puts the Task in a dead end after three failed resumes in a row, with the reason", async () => {
      const s = await working();
      const { driver, github } = s.ports;
      crash(s);
      driver.launch = () => {
        throw new Error("claude not found");
      };

      const next = await s.restart();
      expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
      await next.pollOnce();
      expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
      await next.pollOnce();

      expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
      expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "implement", to: "stuck", reason: resumeFailedReason(3) });
      expect(github.issue(42)).toMatchObject({ labels: ["ready-for-human"], assignees: [] });
      expect(github.commentsOf(42)).toHaveLength(1);
      expect(github.commentsOf(42)[0]?.body).toContain("claude not found");
      expect(next.slots().used).toBe(0);
      const body = await tasks(s);
      expect(body.stuck).toEqual([expect.objectContaining({ issueNumber: 42, reason: resumeFailedReason(3) })]);

      // Nothing more is tried once the Task belongs to the human.
      await next.pollOnce();
      expect(s.index.transitions.listFor(ISSUE).at(-1)?.to).toBe("stuck");
    });

    it("counts a process that exits before its first message as a failed resume", async () => {
      const s = await working();
      const { driver } = s.ports;
      crash(s);
      driver.scriptNextLaunch([]);
      driver.scriptNextLaunch([]);
      driver.scriptNextLaunch([]);

      const next = await s.restart();
      await flush();
      await next.pollOnce();
      await flush();
      await next.pollOnce();
      await flush();

      expect(driver.launches).toHaveLength(4);
      expect(s.index.tasks.get(ISSUE)).toMatchObject({ stage: "stuck" });
      expect(s.index.transitions.listFor(ISSUE).at(-1)?.reason).toBe(resumeFailedReason(3));
    });

    it("resets the failure count once a resumed Session works", async () => {
      const s = await working();
      const { driver } = s.ports;
      crash(s);
      const launch = driver.launch.bind(driver);
      let broken = true;
      driver.launch = (spec) => {
        if (broken) throw new Error("claude not found");
        return launch(spec);
      };

      const next = await s.restart();
      await next.pollOnce();
      expect(s.index.tasks.get(ISSUE).stage).toBe("implement");

      broken = false;
      await next.pollOnce();
      expect(driver.launches).toHaveLength(2);
      const resumed = driver.lastLaunch();
      resumed.emit(sdkMessages.assistantText(SESSION, "still working"));
      await flush();

      // Two new failures after the reset do not reach the limit; the third does.
      crash({ ...s, orchestrator: next } as Scenario);
      broken = true;
      const again = await s.restart();
      await again.pollOnce();
      expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
      await again.pollOnce();
      expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
    });
  });

  describe("hung Agents", () => {
    it("interrupts an Agent silent for 30 minutes and resumes its Session with a nudge; a second hang in a row is a dead end", async () => {
      const s = await working();
      const { driver, clock, github } = s.ports;
      s.implementer.emit(sdkMessages.assistantText(SESSION, "working"));
      await flush();

      await clock.advance(HANG_TIMEOUT_MS - 60_000);
      await s.orchestrator.pollOnce();
      expect(driver.launches).toHaveLength(1);
      expect(s.implementer.calls.map((call) => call.method)).not.toContain("stop");

      await clock.advance(60_000);
      await s.orchestrator.pollOnce();

      expect(s.implementer.calls.map((call) => call.method)).toContain("stop");
      expect(driver.launches).toHaveLength(2);
      const nudged = driver.lastLaunch();
      expect(nudged.launch).toMatchObject({ cwd: WORKTREE, resume: SESSION, prompt: CONTINUE_PROMPT });
      expect(nudged.launch.resumeInterruptedTurn).toBeUndefined();
      expect(s.index.agents.listByIssue(ISSUE)[0]).toMatchObject({ state: "running", pid: 1001 });
      expect(s.index.tasks.get(ISSUE).stage).toBe("implement");

      await clock.advance(HANG_TIMEOUT_MS);
      await s.orchestrator.pollOnce();

      expect(nudged.calls.map((call) => call.method)).toContain("stop");
      expect(driver.launches).toHaveLength(2);
      expect(s.index.tasks.get(ISSUE).stage).toBe("stuck");
      expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "implement", to: "stuck", reason: hungReason(2) });
      expect(github.issue(42)).toMatchObject({ labels: ["ready-for-human"], assignees: [] });
      expect(github.commentsOf(42)).toHaveLength(1);
      expect(s.index.agents.listByIssue(ISSUE)[0]).toMatchObject({ state: "stopped" });
    });

    it("forgets a hang once the Agent finishes a Turn", async () => {
      const s = await working();
      const { driver, clock } = s.ports;
      await clock.advance(HANG_TIMEOUT_MS);
      await s.orchestrator.pollOnce();
      expect(driver.launches).toHaveLength(2);
      const nudged = driver.lastLaunch();
      nudged.emit(sdkMessages.resultSuccess(SESSION, "done"));
      await flush();
      expect(s.index.tasks.get(ISSUE).stage).toBe("qa");

      // The Implementer is back at work on the blockers and goes silent once more: a nudge, not a dead end.
      await s.orchestrator.implementation.send(ISSUE, "blockers");
      await clock.advance(HANG_TIMEOUT_MS);
      await s.orchestrator.pollOnce();

      expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
      const nudges = driver.launches.filter((launch) => launch.launch.resume === SESSION && launch.launch.prompt === CONTINUE_PROMPT);
      expect(nudges).toHaveLength(2);
    });

    it("does not count an Agent between Turns as hung", async () => {
      const s = await working();
      const { driver, clock } = s.ports;
      s.implementer.emit(sdkMessages.resultSuccess(SESSION, "done"));
      await flush();
      expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("idle");
      const qa = driver.lastLaunch();
      qa.emit(sdkMessages.init(SECOND_SESSION));
      qa.emit(sdkMessages.resultSuccess(SECOND_SESSION, JSON.stringify({ approved: true, summary: "ok", blockers: [] })));
      await flush();

      await clock.advance(HANG_TIMEOUT_MS);
      await s.orchestrator.pollOnce();

      expect(driver.launches.filter((launch) => launch.launch.prompt === CONTINUE_PROMPT)).toEqual([]);
      expect(s.index.tasks.get(ISSUE).stage).toBe("done");
    });
  });

  it("drops a resume once the Task left the Pipeline", async () => {
    const s = await working();
    const { github, driver } = s.ports;
    crash(s);
    github.humanUpdateIssue(42, { state: "closed", stateReason: "not_planned" });
    await s.restart();
    expect(s.index.tasks.get(ISSUE).stage).toBe("cancelled");
    expect(driver.launches).toHaveLength(1);
    expect(s.index.installation.find("restart.resume")).toBeUndefined();
  });
});
