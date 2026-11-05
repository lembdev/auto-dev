import { afterEach, describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";
import { WsClient } from "../helpers/ws-client.js";

const SESSION = "22222222-2222-4222-8222-222222222222" as SessionId;

describe("WebSocket events of the index", () => {
  let testApp: TestApp;
  let server: RunningServer | undefined;
  let client: WsClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
    await testApp?.orchestrator.shutdown();
    testApp?.close();
  });

  const connect = async (): Promise<WsClient> => {
    server = await startServer({ app: testApp.app, host: "127.0.0.1", port: 0, log: testApp.log });
    client = await WsClient.connect(`${server.url.replace("http", "ws")}/ws`, { cookie: await testApp.login(), origin: server.url });
    expect(await client.next()).toMatchObject({ type: "hello" });
    return client;
  };

  // Reads events until one of `type` arrives; the ones before it are returned too.
  const until = async (ws: WsClient, type: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 20; i += 1) {
      const event = (await ws.next()) as Record<string, unknown>;
      if (event.type === type) return event;
    }
    throw new Error(`no ${type} event`);
  };

  it("announces a taken Task, the Implementer and the Stage transitions", async () => {
    testApp = createTestApp();
    const ws = await connect();
    testApp.ports.github.seedIssue({ number: 7, title: "Seven", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const at = new Date(testApp.ports.clock.now()).toISOString();

    expect(await until(ws, "transition")).toEqual({ type: "transition", issueNumber: 7, from: null, to: "taken", reason: null, at });
    expect(await until(ws, "agent")).toEqual({ type: "agent", agentId: 1, issueNumber: 7, role: "implementer", state: "running", previous: "stopped" });
    expect(await until(ws, "transition")).toEqual({ type: "transition", issueNumber: 7, from: "taken", to: "implement", reason: "implementer started", at });

    testApp.orchestrator.transition(7 as IssueNumber, "stuck", "gave up");
    expect(await until(ws, "task")).toEqual({ type: "task", issueNumber: 7, stage: "stuck", round: 0 });
    expect(await until(ws, "transition")).toMatchObject({ type: "transition", issueNumber: 7, from: "implement", to: "stuck", reason: "gave up" });
  });

  it("announces a Request when the Agent defers ask_human", async () => {
    testApp = createTestApp();
    const ws = await connect();
    testApp.ports.github.seedIssue({ number: 8, title: "Eight", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const process = testApp.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));
    process.emit(
      sdkMessages.resultSuccess(SESSION, "", {
        stop_reason: "tool_deferred",
        terminal_reason: "tool_deferred",
        deferred_tool_use: { id: "toolu_9", name: ASK_HUMAN_TOOL_NAME, input: { question: "Red or blue?", options: ["red", "blue"] } },
      }),
    );
    process.end();

    expect(await until(ws, "agent")).toMatchObject({ type: "agent", issueNumber: 8, state: "running", previous: "stopped" });
    expect(await until(ws, "agent")).toMatchObject({ type: "agent", issueNumber: 8, state: "waiting", previous: "running" });
    expect(await until(ws, "request")).toEqual({ type: "request", requestId: 1, issueNumber: 8, open: true });
  });

  it("announces the Installation state after the pause toggle and limit readings", async () => {
    testApp = createTestApp();
    const ws = await connect();
    const paused = await testApp.request("/api/installation/pause", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true, reason: "lunch" }),
    });
    expect(paused.status).toBe(200);
    expect(await until(ws, "installation")).toMatchObject({ type: "installation", installation: { paused: true, pause: { reason: "lunch" }, blocker: "paused" } });

    await testApp.request("/api/installation/pause", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: false }) });
    expect(await until(ws, "installation")).toMatchObject({ type: "installation", installation: { paused: false, pause: null } });

    testApp.ports.disk.writeFile(
      "/var/lib/auto-dev/rate_limits.json",
      JSON.stringify({ five_hour: { used_percentage: 61, resets_at: 1767230000 }, updated_at: "2025-12-31T23:00:00.000Z" }),
    );
    await testApp.orchestrator.pollOnce();
    expect(await until(ws, "installation")).toMatchObject({ type: "installation", installation: { limits: { fiveHour: { usedPercent: 61 } } } });
  });
});
