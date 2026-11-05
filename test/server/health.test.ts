import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "../../src/index/migrations.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";
import { WsClient } from "../helpers/ws-client.js";

describe("GET /api/health", () => {
  let testApp: TestApp;
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    testApp?.close();
  });

  it("answers 200 with the version and the schema version", async () => {
    testApp = createTestApp({ version: "1.2.3" });
    const response = await testApp.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "1.2.3", schemaVersion: migrations.at(-1)?.version, uptimeMs: 0 });
  });

  it("reports uptime from the clock port", async () => {
    testApp = createTestApp();
    await testApp.ports.clock.advance(5_000);
    const body = (await (await testApp.request("/api/health")).json()) as { uptimeMs: number };
    expect(body.uptimeMs).toBe(5_000);
  });

  it("is served over a real http server together with the WebSocket endpoint", async () => {
    testApp = createTestApp({ version: "9.9.9" });
    server = await startServer({ app: testApp.app, host: "127.0.0.1", port: 0, log: testApp.log });

    const response = await fetch(`${server.url}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", version: "9.9.9" });

    const client = await WsClient.connect(`${server.url.replace("http", "ws")}/ws`, { cookie: await testApp.login(), origin: server.url });
    expect(await client.next()).toEqual({ type: "hello", version: "9.9.9" });

    testApp.app.broadcast({ type: "hello", version: "broadcast" });
    expect(await client.next()).toEqual({ type: "hello", version: "broadcast" });
    await client.close();
  });

  it("answers 404 as JSON for unknown API routes", async () => {
    testApp = createTestApp();
    const response = await testApp.request("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
