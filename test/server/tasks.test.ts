import { afterEach, describe, expect, it } from "vitest";
import type { IssueNumber } from "../../src/ids.js";
import { INSTALLATION_KEYS } from "../../src/orchestrator/orchestrator.js";
import type { TasksResponse } from "../../src/server/app.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

describe("GET /api/tasks", () => {
  let testApp: TestApp;
  afterEach(() => {
    testApp?.orchestrator.stop();
    testApp?.close();
  });

  const tasks = async (): Promise<TasksResponse> => {
    const response = await testApp.app.request("/api/tasks");
    expect(response.status).toBe(200);
    return (await response.json()) as TasksResponse;
  };

  it("is empty before the first poll", async () => {
    testApp = createTestApp();
    expect(await tasks()).toEqual({ slots: { used: 0, max: 2 }, inProgress: [], ready: [], stuck: [] });
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
        },
        expect.objectContaining({ issueNumber: 2, title: "Second", stage: "implement", pullNumber: 2, pullUrl: "https://github.com/example/product/pull/2" }),
      ],
      ready: [
        { issueNumber: 4, title: "Fourth", milestone: { number: 1, title: "Эпик 1" }, htmlUrl: "https://github.com/example/product/issues/4" },
        { issueNumber: 3, title: "Third", milestone: null, htmlUrl: "https://github.com/example/product/issues/3" },
      ],
      stuck: [],
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
