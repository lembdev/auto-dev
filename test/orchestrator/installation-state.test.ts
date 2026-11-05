import { afterEach, describe, expect, it } from "vitest";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import {
  INSTALLATION_STATE_KEYS,
  SAMPLE_INTERVAL_MS,
  SAMPLE_RETENTION_MS,
  WALL_MARGIN_MS,
  WALL_RETRY_MS,
} from "../../src/orchestrator/installation-state.js";
import { INSTALLATION_KEYS } from "../../src/orchestrator/orchestrator.js";
import { createTestApp, TEST_DATA_DIR, type TestApp } from "../helpers/test-app.js";

const SESSION = "33333333-3333-4333-8333-333333333333" as SessionId;
const FIRST = 1 as IssueNumber;
const MUTATING = ["addAssignees", "removeAssignees", "addLabels", "removeLabel", "updateIssue", "createIssueComment", "updateIssueComment"];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const takenIssues = (testApp: TestApp): number[] =>
  testApp.ports.github.calls.filter((call) => call.method === "addAssignees").map((call) => call.args[0] as number);

const mutations = (testApp: TestApp): number => testApp.ports.github.calls.filter((call) => MUTATING.includes(call.method)).length;

const seconds = (epochMs: number): number => Math.floor(epochMs / 1000);

describe("Pause, the limit and the disk of the Installation", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  // Two Ready issues and one Slot: the second waits for the first to free the Slot.
  const scenario = (options: { maxParallelTasks?: number } = {}): TestApp => {
    const testApp = createTestApp();
    open.push(testApp);
    testApp.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, String(options.maxParallelTasks ?? 1));
    testApp.ports.github.seedIssue({ number: 1, title: "First", labels: ["ready-for-agent"] });
    testApp.ports.github.seedIssue({ number: 2, title: "Second", labels: ["ready-for-agent"] });
    return testApp;
  };

  describe("Pause", () => {
    it("stops taking Ready tasks and starting Implementers but lets live Turns finish", async () => {
      const s = scenario({ maxParallelTasks: 2 });
      s.orchestrator.installation.pause("human", "lunch");
      await s.orchestrator.pollOnce();
      expect(takenIssues(s)).toEqual([]);
      expect(s.orchestrator.canStartTurn()).toBe(false);

      s.orchestrator.installation.unpause();
      await s.orchestrator.pollOnce();
      expect(takenIssues(s)).toEqual([1, 2]);
      const process = s.ports.driver.launches[0]!;

      s.orchestrator.installation.pause("human", "lunch again");
      process.emit(sdkMessages.init(SESSION));
      process.emit(sdkMessages.resultSuccess(SESSION, "done"));
      await flush();
      expect(process.calls.map((call) => call.method)).not.toContain("stop");
      expect(s.index.tasks.get(FIRST).stage).toBe("qa");

      await s.orchestrator.implementation.send(FIRST, "blockers");
      expect(process.sent).toEqual(["blockers"]);
      expect(s.orchestrator.installation.snapshot()).toMatchObject({ paused: true, pause: { source: "human", reason: "lunch again" }, blocker: "paused" });
    });

    it("does not start the Implementer of a Task taken before the Pause until it ends", async () => {
      const s = scenario();
      const launch = s.ports.driver.launch.bind(s.ports.driver);
      s.ports.driver.launch = () => {
        throw new Error("claude not found");
      };
      await s.orchestrator.pollOnce();
      expect(s.index.tasks.get(FIRST).stage).toBe("taken");
      s.ports.driver.launch = launch;

      s.orchestrator.installation.pause("update", "deploying 1.2.0");
      await s.orchestrator.pollOnce();
      expect(s.ports.driver.launches).toHaveLength(0);

      s.orchestrator.installation.unpause();
      await s.orchestrator.pollOnce();
      expect(s.ports.driver.launches).toHaveLength(1);
      expect(s.index.tasks.get(FIRST).stage).toBe("implement");
    });

    it("pauses with a reason when the data disk is 90 % full and deletes nothing", async () => {
      const s = scenario();
      s.ports.disk.setUsage(TEST_DATA_DIR, 91);
      await s.orchestrator.pollOnce();

      expect(takenIssues(s)).toEqual([]);
      expect(s.orchestrator.installation.findPause()).toMatchObject({
        source: "disk",
        reason: `disk at ${TEST_DATA_DIR} is 91 % full (threshold 90 %)`,
      });
      expect(s.orchestrator.installation.snapshot().disk).toMatchObject({ usedPercent: 91 });
      expect(s.ports.worktree.calls.map((call) => call.method)).not.toContain("removeWorktree");

      // A human resumes while the disk is still full: the next cycle pauses again.
      s.orchestrator.installation.unpause();
      s.ports.disk.setUsage(TEST_DATA_DIR, 89.5);
      await s.orchestrator.pollOnce();
      expect(s.orchestrator.installation.paused()).toBe(false);
      expect(takenIssues(s)).toEqual([1]);
    });

    it("pauses when the OAuth token is rejected", async () => {
      const s = scenario();
      await s.orchestrator.pollOnce();
      const process = s.ports.driver.lastLaunch();
      process.emit(sdkMessages.init(SESSION));
      process.emit(sdkMessages.apiRetry(SESSION, "authentication_failed"));
      await flush();
      expect(s.orchestrator.installation.findPause()?.source).toBe("token");
    });
  });

  describe("at the limit", () => {
    it("stops live processes on a rejected rate_limit_event, starts nothing until resetsAt + 2 min, then resumes the interrupted Turns", async () => {
      const s = scenario();
      const { driver, clock } = s.ports;
      await s.orchestrator.pollOnce();
      expect(takenIssues(s)).toEqual([1]);
      const first = driver.lastLaunch();
      first.emit(sdkMessages.init(SESSION));
      const before = mutations(s);
      const resetsAt = clock.now() + 60 * 60_000;

      first.emit(sdkMessages.rateLimitEvent(SESSION, { status: "rejected", rateLimitType: "five_hour", resetsAt: seconds(resetsAt) }));
      await flush();

      expect(first.calls.map((call) => call.method)).toContain("stop");
      expect(s.index.agents.listByIssue(FIRST)[0]?.state).toBe("stopped");
      expect(s.orchestrator.slots().used).toBe(0);
      expect(s.orchestrator.canStartTurn()).toBe(false);
      expect(s.orchestrator.installation.snapshot().atLimit).toEqual({
        since: new Date(clock.now()).toISOString(),
        until: new Date(resetsAt + WALL_MARGIN_MS).toISOString(),
        resetsAt: new Date(resetsAt).toISOString(),
        rejections: 1,
      });

      await clock.advance(30 * 60_000);
      await s.orchestrator.pollOnce();
      expect(takenIssues(s)).toEqual([1]);
      expect(driver.launches).toHaveLength(1);
      expect(mutations(s)).toBe(before);

      await clock.advance(30 * 60_000 + WALL_MARGIN_MS);
      await flush();
      expect(driver.launches).toHaveLength(2);
      expect(driver.lastLaunch().launch).toMatchObject({ resume: SESSION, resumeInterruptedTurn: true });
      expect(driver.lastLaunch().launch.prompt).toBeUndefined();
      expect(s.index.agents.listByIssue(FIRST)).toHaveLength(1);
      expect(s.index.agents.listByIssue(FIRST)[0]?.state).toBe("running");
      expect(s.index.tasks.get(FIRST).stage).toBe("implement");
      expect(s.orchestrator.canStartTurn()).toBe(true);
      expect(s.orchestrator.installation.snapshot().atLimit).toBeNull();
    });

    it("retries five minutes later when the subscription rejects again right after the reset", async () => {
      const s = scenario();
      const { driver, clock } = s.ports;
      await s.orchestrator.pollOnce();
      const first = driver.lastLaunch();
      first.emit(sdkMessages.init(SESSION));
      const resetsAt = clock.now() + 10 * 60_000;
      first.emit(sdkMessages.rateLimitEvent(SESSION, { status: "rejected", resetsAt: seconds(resetsAt) }));
      await flush();
      await clock.advance(10 * 60_000 + WALL_MARGIN_MS);
      await flush();
      expect(driver.launches).toHaveLength(2);

      const resumed = driver.lastLaunch();
      resumed.emit(sdkMessages.rateLimitEvent(SESSION, { status: "rejected", resetsAt: seconds(resetsAt) }));
      await flush();
      expect(resumed.calls.map((call) => call.method)).toContain("stop");
      const retryAt = clock.now() + WALL_RETRY_MS;
      expect(s.orchestrator.installation.snapshot().atLimit).toMatchObject({ until: new Date(retryAt).toISOString(), rejections: 1 });

      await clock.advance(WALL_RETRY_MS - 1000);
      expect(driver.launches).toHaveLength(2);
      await clock.advance(1000);
      await flush();
      expect(driver.launches).toHaveLength(3);
      expect(driver.lastLaunch().launch).toMatchObject({ resume: SESSION, resumeInterruptedTurn: true });
    });

    it("treats an error result with the usage limit text the same way, with a five minute wait when no reset time is known", async () => {
      const s = scenario();
      const { driver, clock } = s.ports;
      await s.orchestrator.pollOnce();
      const first = driver.lastLaunch();
      first.emit(sdkMessages.init(SESSION));
      first.emit(sdkMessages.resultError(SESSION, ["You've hit your limit · resets 3pm (Europe/Berlin)"]));
      await flush();

      expect(first.calls.map((call) => call.method)).toContain("stop");
      expect(s.orchestrator.installation.snapshot().atLimit).toMatchObject({ until: new Date(clock.now() + WALL_RETRY_MS).toISOString(), resetsAt: null });
      expect(s.index.tasks.get(FIRST).stage).toBe("implement");

      await clock.advance(WALL_RETRY_MS);
      await flush();
      expect(driver.launches).toHaveLength(2);
      expect(driver.lastLaunch().launch).toMatchObject({ resume: SESSION, resumeInterruptedTurn: true });
    });

    it("does not confuse an ordinary error result with the limit", async () => {
      const s = scenario();
      await s.orchestrator.pollOnce();
      const first = s.ports.driver.lastLaunch();
      first.emit(sdkMessages.init(SESSION));
      first.emit(sdkMessages.resultError(SESSION, ["boom"]));
      await flush();
      expect(first.calls.map((call) => call.method)).not.toContain("stop");
      expect(s.orchestrator.installation.atLimit()).toBe(false);
    });

    it("survives a restart: the wall is read back from the index and the Turns resume after it", async () => {
      const s = scenario();
      const { driver, clock } = s.ports;
      await s.orchestrator.pollOnce();
      const first = driver.lastLaunch();
      first.emit(sdkMessages.init(SESSION));
      first.emit(sdkMessages.rateLimitEvent(SESSION, { status: "rejected", resetsAt: seconds(clock.now() + 60_000) }));
      await flush();
      s.orchestrator.stop();
      expect(s.orchestrator.installation.findWall()).toBeDefined();

      await clock.advance(60_000 + WALL_MARGIN_MS);
      expect(driver.launches).toHaveLength(1);
      await s.orchestrator.pollOnce();
      expect(driver.launches).toHaveLength(2);
      expect(driver.lastLaunch().launch).toMatchObject({ resume: SESSION, resumeInterruptedTurn: true });
    });
  });

  describe("limit readings", () => {
    it("takes utilization from allowed rate_limit_events and the statusline file, the freshest reading winning", async () => {
      const s = scenario();
      const { driver, clock, disk } = s.ports;
      await s.orchestrator.pollOnce();
      const process = driver.lastLaunch();
      process.emit(sdkMessages.init(SESSION));
      const resetsAt = clock.now() + 3 * 60 * 60_000;
      process.emit(sdkMessages.rateLimitEvent(SESSION, { status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: seconds(resetsAt) }));
      process.emit(sdkMessages.rateLimitEvent(SESSION, { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.8 }));
      await flush();
      expect(s.orchestrator.installation.limits()).toEqual({
        fiveHour: { usedPercent: 42, resetsAt: new Date(resetsAt).toISOString(), at: new Date(clock.now()).toISOString(), source: "event" },
        sevenDay: { usedPercent: 80, resetsAt: null, at: new Date(clock.now()).toISOString(), source: "event" },
      });

      await clock.advance(60_000);
      const weekReset = clock.now() + 2 * 24 * 60 * 60_000;
      disk.writeFile(
        `${TEST_DATA_DIR}/rate_limits.json`,
        JSON.stringify({
          five_hour: { used_percentage: 17, resets_at: seconds(clock.now() - 10 * 60_000) },
          seven_day: { used_percentage: 61, resets_at: seconds(weekReset) },
          updated_at: new Date(clock.now()).toISOString(),
        }),
      );
      await s.orchestrator.pollOnce();
      expect(s.orchestrator.installation.limits()).toMatchObject({
        fiveHour: { usedPercent: 17, source: "statusline" },
        sevenDay: { usedPercent: 61, resetsAt: new Date(weekReset).toISOString(), source: "statusline" },
      });

      // The event from a minute ago is older than the file; it does not overwrite the file's reading.
      process.emit(sdkMessages.rateLimitEvent(SESSION, { status: "allowed", rateLimitType: "seven_day", utilization: 0.5 }));
      await flush();
      expect(s.orchestrator.installation.limits().sevenDay?.usedPercent).toBe(50);
    });

    it("writes a limit sample every ten minutes and drops samples older than 30 days", async () => {
      const s = scenario();
      const { driver, clock } = s.ports;
      await s.orchestrator.pollOnce();
      expect(s.index.limitSamples.list()).toEqual([]);
      s.index.limitSamples.insert({
        at: new Date(clock.now() - SAMPLE_RETENTION_MS - 60_000).toISOString(),
        fiveHour: { usedPercent: 1, resetsAt: null, at: new Date(clock.now() - SAMPLE_RETENTION_MS - 60_000).toISOString(), source: "event" },
        sevenDay: null,
      });
      const process = driver.lastLaunch();
      process.emit(sdkMessages.init(SESSION));
      process.emit(sdkMessages.rateLimitEvent(SESSION, { status: "allowed", rateLimitType: "five_hour", utilization: 0.3 }));
      await flush();

      await clock.advance(SAMPLE_INTERVAL_MS);
      const samples = s.index.limitSamples.list();
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({ at: new Date(clock.now()).toISOString(), fiveHour: { usedPercent: 30, source: "event" }, sevenDay: null });

      await clock.advance(SAMPLE_INTERVAL_MS);
      expect(s.index.limitSamples.list()).toHaveLength(2);
    });

    it("pre-arms at 95 % of the five hour window unless the setting is off or the window has reset", async () => {
      const s = scenario({ maxParallelTasks: 2 });
      const { driver, clock } = s.ports;
      s.ports.github.humanSetLabels(2 as IssueNumber, []);
      await s.orchestrator.pollOnce();
      expect(takenIssues(s)).toEqual([1]);
      const process = driver.lastLaunch();
      process.emit(sdkMessages.init(SESSION));
      const resetsAt = clock.now() + 60 * 60_000;
      process.emit(sdkMessages.rateLimitEvent(SESSION, { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: seconds(resetsAt) }));
      await flush();
      expect(s.orchestrator.canStartTurn()).toBe(false);
      expect(s.orchestrator.installation.snapshot()).toMatchObject({ blocker: "prearm", prearm: { enabled: true, thresholdPercent: 95, active: true } });

      await clock.advance(1000);
      s.ports.github.humanSetLabels(2 as IssueNumber, ["ready-for-agent"]);
      await s.orchestrator.pollOnce();
      expect(takenIssues(s)).toEqual([1]);
      expect(process.calls.map((call) => call.method)).not.toContain("stop");

      s.index.installation.set(INSTALLATION_STATE_KEYS.prearmEnabled, "false");
      expect(s.orchestrator.canStartTurn()).toBe(true);
      s.index.installation.set(INSTALLATION_STATE_KEYS.prearmEnabled, "true");
      expect(s.orchestrator.canStartTurn()).toBe(false);

      await clock.advance(60 * 60_000);
      expect(s.orchestrator.canStartTurn()).toBe(true);
      await s.orchestrator.pollOnce();
      expect(takenIssues(s)).toEqual([1, 2]);
    });
  });
});
