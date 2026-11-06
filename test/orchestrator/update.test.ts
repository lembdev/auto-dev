import { RESTART_PROMPT } from "../../src/orchestrator/turns.js";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { SessionId } from "../../src/ids.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { ORPHAN_GRACE_MS } from "../../src/orchestrator/recovery.js";
import {
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_RETRY_MS,
  TURN_WAIT_TIMEOUT_MS,
  UPDATE_COMMAND,
  UPDATE_PAUSE_REASON,
  compareVersions,
} from "../../src/orchestrator/update-coordinator.js";
import type { InstallationResponse } from "../../src/server/app.js";
import { createTestApp, TEST_HOST, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const LOCAL_TOKEN = "local-updater-token";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("update of the Installation", () => {
  const open: TestApp[] = [];
  const restarted: Orchestrator[] = [];
  afterEach(async () => {
    for (const orchestrator of restarted.splice(0)) await orchestrator.shutdown();
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  const app = (version = "0.1.0"): TestApp => {
    const testApp = createTestApp({ version, localToken: LOCAL_TOKEN });
    open.push(testApp);
    return testApp;
  };

  const installation = async (testApp: TestApp): Promise<InstallationResponse> => {
    const response = await testApp.request("/api/installation");
    expect(response.status).toBe(200);
    return (await response.json()) as InstallationResponse;
  };

  // A taken Task whose Implementer is in the middle of a Turn.
  const working = async (testApp: TestApp): Promise<FakeAgentProcess> => {
    testApp.ports.github.seedIssue({ number: 42, title: "Add login", body: "A login form.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const implementer = testApp.ports.driver.lastLaunch();
    implementer.emit(sdkMessages.init(SESSION));
    await flush();
    return implementer;
  };

  describe("release check", () => {
    it("asks GitHub once a day and shows a newer release in GET /api/installation", async () => {
      const testApp = app("0.1.0");
      const { releases, clock } = testApp.ports;
      releases.publish("0.2.0");

      await testApp.orchestrator.pollOnce();
      expect((await installation(testApp)).update).toEqual({
        current: "0.1.0",
        latest: "0.2.0",
        latestUrl: "https://github.com/lembdev/auto-dev/releases/tag/v0.2.0",
        available: true,
        checkedAt: new Date(clock.now()).toISOString(),
        phase: "idle",
        phaseSince: null,
      });

      releases.publish("0.3.0");
      await clock.advance(RELEASE_CHECK_INTERVAL_MS - 1);
      await testApp.orchestrator.pollOnce();
      expect(releases.calls.filter((call) => call.method === "findLatest")).toHaveLength(1);
      expect((await installation(testApp)).update.latest).toBe("0.2.0");

      await clock.advance(1);
      await testApp.orchestrator.pollOnce();
      expect(releases.calls.filter((call) => call.method === "findLatest")).toHaveLength(2);
      expect((await installation(testApp)).update).toMatchObject({ latest: "0.3.0", available: true });
    });

    it("shows no update when the running version is the latest one", async () => {
      const testApp = app("0.2.0");
      testApp.ports.releases.publish("0.2.0");
      await testApp.orchestrator.pollOnce();
      expect((await installation(testApp)).update).toMatchObject({ current: "0.2.0", latest: "0.2.0", available: false });
    });

    it("keeps the last answer when GitHub fails and retries within the hour, not on every cycle", async () => {
      const testApp = app("0.1.0");
      const { releases, clock } = testApp.ports;
      releases.publish("0.2.0");
      await testApp.orchestrator.pollOnce();
      await clock.advance(RELEASE_CHECK_INTERVAL_MS);

      releases.failure = new Error("network down");
      await testApp.orchestrator.pollOnce();
      await testApp.orchestrator.pollOnce();
      expect(releases.calls.filter((call) => call.method === "findLatest")).toHaveLength(2);
      expect((await installation(testApp)).update).toMatchObject({ latest: "0.2.0", available: true });

      releases.failure = undefined;
      releases.publish("0.3.0");
      await clock.advance(RELEASE_RETRY_MS);
      await testApp.orchestrator.pollOnce();
      expect((await installation(testApp)).update.latest).toBe("0.3.0");
    });

    it("orders versions semantically, a pre-release below its release", () => {
      expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
      expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    });
  });

  describe("the Обновить button", () => {
    it("starts the updater through sudo outside the service and answers at once", async () => {
      const testApp = app();
      const response = await testApp.request("/api/installation/update", { method: "POST" });
      expect(response.status).toBe(202);
      expect(((await response.json()) as InstallationResponse).update.phase).toBe("requested");
      expect(testApp.ports.processes.spawned).toEqual([{ command: "sudo", args: [...UPDATE_COMMAND.args], pid: expect.any(Number) }]);
      expect(UPDATE_COMMAND.args).toContain("/usr/bin/update");
      expect(UPDATE_COMMAND.args[0]).toBe("-n");
    });

    it("refuses a second start while the first is under way", async () => {
      const testApp = app();
      await testApp.request("/api/installation/update", { method: "POST" });
      const again = await testApp.request("/api/installation/update", { method: "POST" });
      expect(again.status).toBe(409);
      expect(testApp.ports.processes.spawned).toHaveLength(1);
    });

    it("reports a failed start and stays idle", async () => {
      const testApp = app();
      testApp.ports.processes.spawnFailure = new Error("sudo: a password is required");
      const response = await testApp.request("/api/installation/update", { method: "POST" });
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: string }).error).toContain("a password is required");
      expect((await installation(testApp)).update.phase).toBe("idle");
    });

    it("needs a session", async () => {
      const testApp = app();
      const response = await testApp.app.request("/api/installation/update", { method: "POST", headers: { host: TEST_HOST } });
      expect(response.status).toBe(401);
      expect(testApp.ports.processes.spawned).toHaveLength(0);
    });
  });

  describe("preparation before the service stops", () => {
    const prepare = (testApp: TestApp, token = LOCAL_TOKEN) =>
      testApp.app.request("/api/installation/prepare-update", { method: "POST", headers: { host: "127.0.0.1:8080", authorization: `Bearer ${token}` } });

    it("pauses with the update source and is ready once the running Turn ends", async () => {
      const testApp = app();
      const implementer = await working(testApp);

      const response = await prepare(testApp);
      expect(response.status).toBe(202);
      await flush();
      const preparing = await installation(testApp);
      expect(preparing.pause).toMatchObject({ source: "update", reason: UPDATE_PAUSE_REASON });
      expect(preparing.update.phase).toBe("preparing");

      implementer.emit(sdkMessages.resultSuccess(SESSION, "done for now"));
      await flush();
      await testApp.ports.clock.advance(5_000);
      expect((await installation(testApp)).update.phase).toBe("ready");
      expect(implementer.calls.map((call) => call.method)).not.toContain("interrupt");
    });

    it("waits at most ten minutes, then interrupts the Turn", async () => {
      const testApp = app();
      const implementer = await working(testApp);
      await prepare(testApp);
      await flush();

      await testApp.ports.clock.advance(TURN_WAIT_TIMEOUT_MS - 5_000);
      expect((await installation(testApp)).update.phase).toBe("preparing");
      expect(implementer.calls.map((call) => call.method)).not.toContain("interrupt");

      await testApp.ports.clock.advance(5_000);
      await flush();
      expect(implementer.calls.map((call) => call.method)).toContain("interrupt");
      expect((await installation(testApp)).update.phase).toBe("ready");
    });

    it("lifts the update Pause on the next start and resumes the interrupted Turn", async () => {
      const testApp = app("0.1.0");
      await working(testApp);
      await prepare(testApp);
      await flush();
      await testApp.ports.clock.advance(TURN_WAIT_TIMEOUT_MS);
      await flush();
      await testApp.orchestrator.shutdown();
      const launches = testApp.ports.driver.launches.length;

      const next = new Orchestrator({ ports: testApp.ports, index: testApp.index, log: testApp.log, product: { repoPath: TEST_REPO_PATH }, version: "0.2.0" });
      restarted.push(next);
      const cycle = next.pollOnce();
      await flush();
      await testApp.ports.clock.advance(ORPHAN_GRACE_MS);
      await cycle;

      expect(next.installation.findPause()).toBeUndefined();
      expect(next.updates.view()).toMatchObject({ current: "0.2.0", phase: "idle" });
      expect(testApp.ports.driver.launches.length).toBe(launches + 1);
      expect(testApp.ports.driver.lastLaunch().launch).toMatchObject({ resume: SESSION, prompt: RESTART_PROMPT });
    });

    it("resumes the Planner Turn the update interrupted as the open Planner", async () => {
      const testApp = app("0.1.0");
      const plannerSession = "44444444-4444-4444-8444-444444444444" as SessionId;
      await testApp.orchestrator.planner.start({ mode: "new" });
      testApp.ports.driver.lastLaunch().emit(sdkMessages.init(plannerSession));
      await flush();
      await prepare(testApp);
      await flush();
      await testApp.ports.clock.advance(TURN_WAIT_TIMEOUT_MS);
      await flush();
      await testApp.orchestrator.shutdown();

      const next = new Orchestrator({ ports: testApp.ports, index: testApp.index, log: testApp.log, product: { repoPath: TEST_REPO_PATH }, version: "0.2.0" });
      restarted.push(next);
      const cycle = next.pollOnce();
      await flush();
      await testApp.ports.clock.advance(ORPHAN_GRACE_MS);
      await cycle;

      expect(testApp.ports.driver.lastLaunch().launch).toMatchObject({ resume: plannerSession, prompt: RESTART_PROMPT, cwd: TEST_REPO_PATH });
      expect(next.planner.snapshot()).toMatchObject({ open: true, status: "running" });
    });

    it("keeps a human Pause the update did not set", async () => {
      const testApp = app();
      testApp.orchestrator.installation.pause("human", "holiday");
      await prepare(testApp);
      await flush();
      expect((await installation(testApp)).pause).toMatchObject({ source: "human", reason: "holiday" });

      const next = new Orchestrator({ ports: testApp.ports, index: testApp.index, log: testApp.log, product: { repoPath: TEST_REPO_PATH } });
      restarted.push(next);
      await next.pollOnce();
      expect(next.installation.findPause()).toMatchObject({ source: "human" });
    });

    it("lets the local token reach only the preparation and the installation view", async () => {
      const testApp = app();
      expect((await prepare(testApp, "wrong")).status).toBe(401);
      const view = await testApp.app.request("/api/installation", { headers: { host: "127.0.0.1:8080", authorization: `Bearer ${LOCAL_TOKEN}` } });
      expect(view.status).toBe(200);
      const update = await testApp.app.request("/api/installation/update", { method: "POST", headers: { host: "127.0.0.1:8080", authorization: `Bearer ${LOCAL_TOKEN}` } });
      expect(update.status).toBe(401);
      const tasks = await testApp.app.request("/api/tasks", { headers: { host: "127.0.0.1:8080", authorization: `Bearer ${LOCAL_TOKEN}` } });
      expect(tasks.status).toBe(401);
    });
  });
});
