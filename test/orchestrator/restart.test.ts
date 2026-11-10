import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { SessionId } from "../../src/ids.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { ORPHAN_GRACE_MS } from "../../src/orchestrator/recovery.js";
import { RESTART_PAUSE_REASON } from "../../src/orchestrator/restart-drain.js";
import { RESTART_PROMPT } from "../../src/orchestrator/turns.js";
import type { InstallationResponse } from "../../src/server/app.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("restart prepared by hand", () => {
  const open: TestApp[] = [];
  const restarted: Orchestrator[] = [];
  afterEach(async () => {
    for (const orchestrator of restarted.splice(0)) await orchestrator.shutdown();
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  const app = (): TestApp => {
    const testApp = createTestApp();
    open.push(testApp);
    return testApp;
  };

  const call = async (testApp: TestApp, path: string, method: string): Promise<InstallationResponse> => {
    const response = await testApp.request(path, { method });
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

  const restart = async (testApp: TestApp): Promise<Orchestrator> => {
    await testApp.orchestrator.shutdown();
    const next = new Orchestrator({ ports: testApp.ports, index: testApp.index, log: testApp.log, product: { repoPath: TEST_REPO_PATH } });
    restarted.push(next);
    const cycle = next.pollOnce();
    await flush();
    await testApp.ports.clock.advance(ORPHAN_GRACE_MS);
    await cycle;
    return next;
  };

  it("pauses, lists the running Turn and turns ready once it ends, without interrupting it", async () => {
    const testApp = app();
    const implementer = await working(testApp);

    const draining = await call(testApp, "/api/installation/restart", "POST");
    expect(draining.pause).toMatchObject({ source: "restart", reason: RESTART_PAUSE_REASON });
    expect(draining.restart).toMatchObject({ active: true, ready: false, liftsPause: true, running: [{ issueNumber: 42, role: "implementer" }] });

    implementer.emit(sdkMessages.resultSuccess(SESSION, "done for now"));
    await flush();
    expect((await call(testApp, "/api/installation", "GET")).restart).toMatchObject({ active: true, ready: true, running: [] });
    expect(implementer.calls.map((call) => call.method)).not.toContain("interrupt");
  });

  it("starts nothing new while preparing and lifts its own Pause on the next start", async () => {
    const testApp = app();
    await call(testApp, "/api/installation/restart", "POST");
    testApp.ports.github.seedIssue({ number: 7, title: "Later", body: "Not now.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    expect(testApp.ports.driver.launches).toHaveLength(0);

    const next = await restart(testApp);
    expect(next.installation.findPause()).toBeUndefined();
    expect(next.restart.view().active).toBe(false);
  });

  it("interrupts the running Turns on request, and the restart resumes them in their Sessions", async () => {
    const testApp = app();
    const implementer = await working(testApp);
    await call(testApp, "/api/installation/restart", "POST");

    await call(testApp, "/api/installation/restart/interrupt", "POST");
    expect(implementer.calls.map((call) => call.method)).toContain("interrupt");
    const launches = testApp.ports.driver.launches.length;

    await restart(testApp);
    expect(testApp.ports.driver.launches.length).toBe(launches + 1);
    expect(testApp.ports.driver.lastLaunch().launch).toMatchObject({ resume: SESSION, prompt: RESTART_PROMPT });
  });

  it("keeps a human Pause that was on before, through the restart", async () => {
    const testApp = app();
    testApp.orchestrator.installation.pause("human", "holiday");
    const draining = await call(testApp, "/api/installation/restart", "POST");
    expect(draining.pause).toMatchObject({ source: "human", reason: "holiday" });
    expect(draining.restart).toMatchObject({ active: true, ready: true, liftsPause: false });

    const next = await restart(testApp);
    expect(next.installation.findPause()).toMatchObject({ source: "human" });
    expect(next.restart.view().active).toBe(false);
  });

  it("cancels: its own Pause goes, nothing is left armed", async () => {
    const testApp = app();
    await call(testApp, "/api/installation/restart", "POST");
    const cancelled = await call(testApp, "/api/installation/restart", "DELETE");
    expect(cancelled.paused).toBe(false);
    expect(cancelled.restart.active).toBe(false);
  });
});
