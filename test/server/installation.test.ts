import { afterEach, describe, expect, it } from "vitest";
import type { InstallationResponse } from "../../src/server/app.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

describe("/api/installation", () => {
  let testApp: TestApp;
  afterEach(() => {
    testApp?.close();
  });

  const get = async (): Promise<InstallationResponse> => {
    const response = await testApp.app.request("/api/installation");
    expect(response.status).toBe(200);
    return (await response.json()) as InstallationResponse;
  };

  const put = (body: unknown) =>
    testApp.app.request("/api/installation/pause", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("reports the indicator of a fresh Installation", async () => {
    testApp = createTestApp();
    expect(await get()).toEqual({
      paused: false,
      pause: null,
      atLimit: null,
      limits: { fiveHour: null, sevenDay: null },
      prearm: { enabled: true, thresholdPercent: 95, active: false },
      disk: null,
      blocker: null,
      canStartTurn: true,
      slots: { used: 0, max: 2 },
    });
  });

  it("pauses and resumes the Installation on PUT, with the reason", async () => {
    testApp = createTestApp();
    const paused = await put({ paused: true, reason: "going on holiday" });
    expect(paused.status).toBe(200);
    const since = new Date(testApp.ports.clock.now()).toISOString();
    expect(((await paused.json()) as InstallationResponse).pause).toEqual({ source: "human", reason: "going on holiday", since });
    expect(await get()).toMatchObject({ paused: true, blocker: "paused", canStartTurn: false });
    expect(testApp.orchestrator.canStartTurn()).toBe(false);

    const byDefault = await put({ paused: true });
    expect(((await byDefault.json()) as InstallationResponse).pause?.reason).toBe("paused from the UI");

    const resumed = await put({ paused: false });
    expect(resumed.status).toBe(200);
    expect(await get()).toMatchObject({ paused: false, pause: null, canStartTurn: true });
  });

  it("rejects a body without a boolean `paused`", async () => {
    testApp = createTestApp();
    expect((await put({ paused: "yes" })).status).toBe(400);
    expect((await put({ reason: "x" })).status).toBe(400);
    expect((await put("not json")).status).toBe(400);
    expect((await put({ paused: true, source: "alien" })).status).toBe(400);
    expect(await get()).toMatchObject({ paused: false });
  });

  it("shows the limits, the wall and the disk after a poll", async () => {
    testApp = createTestApp();
    testApp.ports.disk.setUsage("/var/lib/auto-dev", 42.5);
    testApp.ports.disk.writeFile(
      "/var/lib/auto-dev/rate_limits.json",
      JSON.stringify({ five_hour: { used_percentage: 33, resets_at: 1767230000 }, updated_at: "2025-12-31T23:00:00.000Z" }),
    );
    await testApp.orchestrator.pollOnce();
    expect(await get()).toMatchObject({
      disk: { usedPercent: 42.5 },
      limits: { fiveHour: { usedPercent: 33, resetsAt: "2026-01-01T01:13:20.000Z", at: "2025-12-31T23:00:00.000Z", source: "statusline" }, sevenDay: null },
    });
  });
});
