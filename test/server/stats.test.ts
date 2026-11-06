import { afterEach, describe, expect, it } from "vitest";
import type { IssueNumber } from "../../src/ids.js";
import type { TaskStage } from "../../src/index/tasks.js";
import type { LimitHistoryResponse, StatsResponse } from "../../src/server/app.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

describe("GET /api/stats", () => {
  let testApp: TestApp;
  afterEach(() => {
    testApp?.orchestrator.stop();
    testApp?.close();
  });

  const stats = async (query = ""): Promise<StatsResponse> => {
    const response = await testApp.request(`/api/stats${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as StatsResponse;
  };

  // Appends one Stage change `offsetMs` after `start`, bypassing the Orchestrator: the history is the fixture.
  const history = (start: number) => {
    const { transitions } = testApp.index;
    return (issue: number, offsetMs: number, from: TaskStage | null, to: TaskStage, reason: string | null = null) =>
      transitions.append({ issueNumber: issue as IssueNumber, from, to, reason, at: new Date(start + offsetMs).toISOString() });
  };

  it("is all zeros on an empty index", async () => {
    testApp = createTestApp();
    const body = await stats();
    expect(body).toMatchObject({ days: 7, taken: 0, done: 0, stuck: 0 });
    expect(body.stages).toEqual([
      { stage: "implement", count: 0, meanMs: null, medianMs: null },
      { stage: "qa", count: 0, meanMs: null, medianMs: null },
      { stage: "merge", count: 0, meanMs: null, medianMs: null },
    ]);
    expect(body.rounds).toEqual({ tasks: 0, mean: null, buckets: [] });
  });

  it("accepts only 7 or 30 days", async () => {
    testApp = createTestApp();
    expect((await testApp.request("/api/stats?days=30")).status).toBe(200);
    expect((await testApp.request("/api/stats?days=5")).status).toBe(400);
    expect((await testApp.request("/api/stats?days=week")).status).toBe(400);
  });

  it("counts takes, merges and dead ends, Stage times and Rounds over a known history", async () => {
    testApp = createTestApp();
    const { clock } = testApp.ports;
    const start = clock.now();
    const at = history(start);

    // Task 1: taken, one QA Round with blockers, approved on the second, merged. 3 days ago.
    at(1, 0, null, "taken");
    at(1, 10 * 60_000, "taken", "implement", "implementer started");
    at(1, 2 * HOUR_MS, "implement", "qa", "implementer turn finished");
    at(1, 2 * HOUR_MS + 30 * 60_000, "qa", "implement", "qa round 1: 2 blockers");
    at(1, 3 * HOUR_MS, "implement", "qa", "implementer turn finished");
    at(1, 3 * HOUR_MS + 30 * 60_000, "qa", "merge", "qa round 2: approved");
    at(1, 4 * HOUR_MS, "merge", "done", "pull request merged");

    // Task 2: taken, approved on the first Round, merged. 2 days ago.
    at(2, DAY_MS, null, "taken");
    at(2, DAY_MS + 60_000, "taken", "implement", "implementer started");
    at(2, DAY_MS + 4 * HOUR_MS, "implement", "qa", "implementer turn finished");
    at(2, DAY_MS + 5 * HOUR_MS, "qa", "merge", "qa round 1: approved");
    at(2, DAY_MS + 5 * HOUR_MS + 30 * 60_000, "merge", "done", "pull request merged");

    // Task 3: taken, three Rounds with blockers, dead end. 1 day ago.
    at(3, 2 * DAY_MS, null, "taken");
    at(3, 2 * DAY_MS + 60_000, "taken", "implement", "implementer started");
    at(3, 2 * DAY_MS + 1 * HOUR_MS, "implement", "qa", "implementer turn finished");
    at(3, 2 * DAY_MS + 2 * HOUR_MS, "qa", "implement", "qa round 1: 3 blockers");
    at(3, 2 * DAY_MS + 3 * HOUR_MS, "implement", "qa", "implementer turn finished");
    at(3, 2 * DAY_MS + 4 * HOUR_MS, "qa", "implement", "qa round 2: 1 blockers");
    at(3, 2 * DAY_MS + 5 * HOUR_MS, "implement", "qa", "implementer turn finished");
    at(3, 2 * DAY_MS + 6 * HOUR_MS, "qa", "stuck", "qa round 3: 1 blockers");

    // Task 4: taken and still implementing: an open Stage counts nowhere yet.
    at(4, 2 * DAY_MS + 7 * HOUR_MS, null, "taken");
    at(4, 2 * DAY_MS + 7 * HOUR_MS + 60_000, "taken", "implement", "implementer started");

    await clock.advance(3 * DAY_MS);
    const week = await stats("?days=7");
    expect(week).toMatchObject({ days: 7, taken: 4, done: 2, stuck: 1 });

    // implement: task 1: 110 min + 30 min; task 2: 239 min; task 3: 59 + 60 + 60 min.
    const implement = week.stages.find((stage) => stage.stage === "implement")!;
    expect(implement.count).toBe(6);
    expect(implement.medianMs).toBe(60 * 60_000);
    expect(implement.meanMs).toBe(Math.round(((110 + 30 + 239 + 59 + 60 + 60) * 60_000) / 6));
    // qa: task 1: 30 + 30 min; task 2: 60 min; task 3: 60 + 60 + 60 min.
    const qa = week.stages.find((stage) => stage.stage === "qa")!;
    expect(qa.count).toBe(6);
    expect(qa.medianMs).toBe(60 * 60_000);
    expect(qa.meanMs).toBe(Math.round(((30 + 30 + 60 + 60 + 60 + 60) * 60_000) / 6));
    // merge: task 1: 30 min; task 2: 30 min.
    const merge = week.stages.find((stage) => stage.stage === "merge")!;
    expect(merge).toEqual({ stage: "merge", count: 2, meanMs: 30 * 60_000, medianMs: 30 * 60_000 });

    // Rounds per finished Task: 2, 1, 3.
    expect(week.rounds).toEqual({
      tasks: 3,
      mean: 2,
      buckets: [
        { rounds: 1, tasks: 1 },
        { rounds: 2, tasks: 1 },
        { rounds: 3, tasks: 1 },
      ],
    });
  });

  it("looks back 7 or 30 days from now and counts a Stage where it ended", async () => {
    testApp = createTestApp();
    const { clock } = testApp.ports;
    const start = clock.now();
    const at = history(start);

    // Task 1 finished 20 days ago: inside 30 days, outside 7.
    at(1, 0, null, "taken");
    at(1, 60_000, "taken", "implement");
    at(1, HOUR_MS, "implement", "qa");
    at(1, 2 * HOUR_MS, "qa", "merge");
    at(1, 3 * HOUR_MS, "merge", "done");
    // Task 2 was taken 20 days ago but reached QA only 2 days ago: its implement time counts in the week.
    at(2, 0, null, "taken");
    at(2, 60_000, "taken", "implement");
    at(2, 18 * DAY_MS, "implement", "qa");
    // Task 3 returns from a dead end 10 days ago: the second take counts as a take too.
    at(3, 10 * DAY_MS, null, "taken");
    at(3, 10 * DAY_MS + HOUR_MS, "taken", "stuck", "launch failed");
    at(3, 10 * DAY_MS + 2 * HOUR_MS, "stuck", "taken");

    await clock.advance(20 * DAY_MS);
    const week = await stats("?days=7");
    expect(week).toMatchObject({ days: 7, taken: 0, done: 0, stuck: 0 });
    expect(week.since).toBe(new Date(clock.now() - 7 * DAY_MS).toISOString());
    expect(week.stages.find((stage) => stage.stage === "implement")).toEqual({ stage: "implement", count: 1, meanMs: 18 * DAY_MS - 60_000, medianMs: 18 * DAY_MS - 60_000 });
    expect(week.rounds).toEqual({ tasks: 0, mean: null, buckets: [] });

    const month = await stats("?days=30");
    expect(month).toMatchObject({ days: 30, taken: 4, done: 1, stuck: 1 });
    expect(month.stages.find((stage) => stage.stage === "implement")?.count).toBe(2);
    expect(month.rounds).toEqual({ tasks: 2, mean: 0.5, buckets: [{ rounds: 0, tasks: 1 }, { rounds: 1, tasks: 1 }] });
  });

  it("reflects transitions made by the Orchestrator", async () => {
    testApp = createTestApp();
    const { github, clock } = testApp.ports;
    github.seedIssue({ number: 1, title: "One", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    await clock.advance(HOUR_MS);
    testApp.orchestrator.transition(1 as IssueNumber, "qa");
    await clock.advance(HOUR_MS);
    testApp.orchestrator.transition(1 as IssueNumber, "merge");
    testApp.orchestrator.transition(1 as IssueNumber, "done");

    const body = await stats();
    expect(body).toMatchObject({ taken: 1, done: 1, stuck: 0 });
    expect(body.stages.find((stage) => stage.stage === "qa")).toEqual({ stage: "qa", count: 1, meanMs: HOUR_MS, medianMs: HOUR_MS });
  });
});

describe("GET /api/stats/limits", () => {
  let testApp: TestApp;
  afterEach(() => {
    testApp?.orchestrator.stop();
    testApp?.close();
  });

  it("is empty on an empty index", async () => {
    testApp = createTestApp();
    const response = await testApp.request("/api/stats/limits");
    expect(response.status).toBe(200);
    expect((await response.json()) as LimitHistoryResponse).toMatchObject({ days: 7, samples: [] });
  });

  it("returns the samples of the period, oldest first", async () => {
    testApp = createTestApp();
    const { clock } = testApp.ports;
    const start = clock.now();
    const reading = (usedPercent: number, at: string) => ({ usedPercent, resetsAt: null, at, source: "statusline" as const });
    const sample = (offsetMs: number, fiveHour: number, sevenDay: number | null) => {
      const at = new Date(start + offsetMs).toISOString();
      testApp.index.limitSamples.insert({ at, fiveHour: reading(fiveHour, at), sevenDay: sevenDay === null ? null : reading(sevenDay, at) });
      return at;
    };
    sample(0, 10, 5);
    const second = sample(25 * DAY_MS, 40, 20);
    const third = sample(29 * DAY_MS, 70, null);
    await clock.advance(30 * DAY_MS);

    const week = (await (await testApp.request("/api/stats/limits?days=7")).json()) as LimitHistoryResponse;
    expect(week.days).toBe(7);
    expect(week.samples.map((s) => s.at)).toEqual([second, third]);
    expect(week.samples[0]).toMatchObject({ fiveHour: { usedPercent: 40 }, sevenDay: { usedPercent: 20 } });
    expect(week.samples[1]).toMatchObject({ fiveHour: { usedPercent: 70 }, sevenDay: null });

    const month = (await (await testApp.request("/api/stats/limits?days=30")).json()) as LimitHistoryResponse;
    expect(month.samples).toHaveLength(3);
    expect((await testApp.request("/api/stats/limits?days=1")).status).toBe(400);
  });

  it("requires a session", async () => {
    testApp = createTestApp();
    expect((await testApp.app.request("/api/stats", { headers: { host: "localhost" } })).status).toBe(401);
    expect((await testApp.app.request("/api/stats/limits", { headers: { host: "localhost" } })).status).toBe(401);
    expect((await testApp.app.request("/api/logs", { headers: { host: "localhost" } })).status).toBe(401);
  });
});
