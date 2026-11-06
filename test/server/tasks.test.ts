import { afterEach, describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import { INSTALLATION_KEYS } from "../../src/orchestrator/orchestrator.js";
import type { TasksResponse } from "../../src/server/app.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

const SESSION = "44444444-4444-4444-8444-444444444444" as SessionId;

describe("GET /api/tasks", () => {
  let testApp: TestApp;
  afterEach(() => {
    testApp?.orchestrator.stop();
    testApp?.close();
  });

  const tasks = async (): Promise<TasksResponse> => {
    const response = await testApp.request("/api/tasks");
    expect(response.status).toBe(200);
    return (await response.json()) as TasksResponse;
  };

  it("is empty before the first poll", async () => {
    testApp = createTestApp();
    expect(await tasks()).toEqual({ slots: { used: 0, max: 2 }, maxQaRounds: 3, inProgress: [], ready: [], stuck: [], cancelled: [] });
  });

  it("shows Tasks in progress, the Ready queue in order and the Slots", async () => {
    testApp = createTestApp();
    const { github, clock } = testApp.ports;
    const m1 = github.seedMilestone({ number: 1, title: "Эпик 1" });
    github.seedIssue({ number: 3, title: "Third", labels: ["ready-for-agent"] });
    github.seedIssue({ number: 1, title: "First", labels: ["ready-for-agent"], milestone: m1 });
    github.seedIssue({ number: 2, title: "Second", labels: ["ready-for-agent"], milestone: m1 });
    github.seedIssue({ number: 4, title: "Fourth", labels: ["ready-for-agent"], milestone: m1 });
    await clock.advance(1_000);

    await testApp.orchestrator.pollOnce();
    const takenAt = new Date(clock.now()).toISOString();

    expect(await tasks()).toEqual({
      slots: { used: 2, max: 2 },
      maxQaRounds: 3,
      inProgress: [
        {
          issueNumber: 1,
          title: "First",
          milestone: { number: 1, title: "Эпик 1" },
          stage: "implement",
          round: 0,
          attempt: 1,
          pullNumber: 1,
          branch: "worktree-issue-1",
          worktreePath: "/var/lib/auto-dev/repo/.claude/worktrees/issue-1",
          takenAt,
          updatedAt: takenAt,
          htmlUrl: "https://github.com/example/product/issues/1",
          pullUrl: "https://github.com/example/product/pull/1",
          transitions: [
            { id: 1, issueNumber: 1, from: null, to: "taken", reason: null, at: takenAt },
            { id: 2, issueNumber: 1, from: "taken", to: "implement", reason: "implementer started", at: takenAt },
          ],
          agent: { id: 1, role: "implementer", state: "running", lastTurnAt: null, createdAt: takenAt },
          request: null,
        },
        expect.objectContaining({ issueNumber: 2, title: "Second", stage: "implement", pullNumber: 2, pullUrl: "https://github.com/example/product/pull/2" }),
      ],
      ready: [
        { issueNumber: 4, title: "Fourth", milestone: { number: 1, title: "Эпик 1" }, htmlUrl: "https://github.com/example/product/issues/4" },
        { issueNumber: 3, title: "Third", milestone: null, htmlUrl: "https://github.com/example/product/issues/3" },
      ],
      stuck: [],
      cancelled: [],
    });
  });

  it("moves a Task out of progress when its Stage ends and lists dead ends separately", async () => {
    testApp = createTestApp();
    testApp.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, "3");
    const { github } = testApp.ports;
    github.seedIssue({ number: 1, labels: ["ready-for-agent"] });
    github.seedIssue({ number: 2, labels: ["ready-for-agent"] });
    github.seedIssue({ number: 3, labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();

    testApp.orchestrator.transition(1 as IssueNumber, "done");
    testApp.orchestrator.transition(2 as IssueNumber, "stuck", "QA failed twice");
    const body = await tasks();
    expect(body.slots).toEqual({ used: 1, max: 3 });
    expect(body.inProgress.map((task) => task.issueNumber)).toEqual([3]);
    expect(body.stuck.map((task) => [task.issueNumber, task.reason])).toEqual([[2, "QA failed twice"]]);
  });
});

describe("GET /api/tasks with a waiting Agent", () => {
  it("shows the Agent state and the open Request of the Task", async () => {
    const testApp = createTestApp();
    try {
      const { github, driver } = testApp.ports;
      github.seedIssue({ number: 5, title: "Five", labels: ["ready-for-agent"] });
      await testApp.orchestrator.pollOnce();
      const process = driver.lastLaunch();
      process.emit(sdkMessages.init(SESSION));
      process.emit(
        sdkMessages.resultSuccess(SESSION, "", {
          stop_reason: "tool_deferred",
          terminal_reason: "tool_deferred",
          deferred_tool_use: { id: "toolu_5", name: ASK_HUMAN_TOOL_NAME, input: { question: "Which database?\nPostgres is already there.", options: ["postgres", "sqlite"] } },
        }),
      );
      process.end();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const askedAt = new Date(testApp.ports.clock.now()).toISOString();

      const body = (await (await testApp.request("/api/tasks")).json()) as TasksResponse;
      expect(body.slots).toEqual({ used: 0, max: 2 });
      expect(body.inProgress).toEqual([
        expect.objectContaining({
          issueNumber: 5,
          stage: "implement",
          agent: { id: 1, role: "implementer", state: "waiting", lastTurnAt: askedAt, createdAt: askedAt },
          request: {
            id: 1,
            agentId: 1,
            commentId: github.commentsOf(5)[0]!.id,
            commentUrl: `https://github.com/example/product/issues/5#issuecomment-${github.commentsOf(5)[0]!.id}`,
            createdAt: askedAt,
            question: "Which database?\nPostgres is already there.",
            options: ["postgres", "sqlite"],
          },
        }),
      ]);
    } finally {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });
});
