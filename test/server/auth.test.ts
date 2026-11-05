import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SESSION_TTL_MS } from "../../src/server/auth.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import { createTestApp, sessionCookieOf, TEST_HOST, TEST_PASSWORD, type TestApp } from "../helpers/test-app.js";
import { WsClient } from "../helpers/ws-client.js";

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", host: TEST_HOST, ...headers },
  body: JSON.stringify(body),
});

// Status of a WebSocket handshake the server refused.
const handshakeStatus = (url: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("handshake unexpectedly succeeded"));
    });
    socket.once("error", reject);
  });

describe("access to the API", () => {
  let testApp: TestApp;
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    testApp?.close();
  });

  it("answers 401 on every API route without a session, except health, session and login", async () => {
    testApp = createTestApp();
    const host = { host: TEST_HOST };
    for (const path of ["/api/tasks", "/api/installation", "/api/digest?since=2026-01-01T00:00:00.000Z"]) {
      const response = await testApp.app.request(path, { headers: host });
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect((await testApp.app.request("/api/installation/pause", { method: "PUT", headers: host, body: JSON.stringify({ paused: true }) })).status).toBe(401);
    expect(testApp.orchestrator.installation.paused()).toBe(false);
    expect((await testApp.app.request("/api/health", { headers: host })).status).toBe(200);
    expect(await (await testApp.app.request("/api/session", { headers: host })).json()).toEqual({ authenticated: false, passwordSet: true });
  });

  it("logs in with the password and sets a session cookie for 30 days", async () => {
    testApp = createTestApp();
    const wrong = await testApp.app.request("/api/login", json({ password: "nope" }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const ok = await testApp.app.request("/api/login", json({ password: TEST_PASSWORD }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ authenticated: true, passwordSet: true });
    const header = ok.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^auto_dev_session=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);

    const cookie = sessionCookieOf(ok);
    const tasks = await testApp.app.request("/api/tasks", { headers: { cookie, host: TEST_HOST } });
    expect(tasks.status).toBe(200);
    expect(await (await testApp.app.request("/api/session", { headers: { cookie, host: TEST_HOST } })).json()).toEqual({ authenticated: true, passwordSet: true });

    await testApp.ports.clock.advance(SESSION_TTL_MS - 60_000);
    expect((await testApp.app.request("/api/tasks", { headers: { cookie, host: TEST_HOST } })).status).toBe(200);
    await testApp.ports.clock.advance(2 * 60_000);
    expect((await testApp.app.request("/api/tasks", { headers: { cookie, host: TEST_HOST } })).status).toBe(401);
  });

  it("rejects a tampered or foreign cookie, a malformed login body and logs out", async () => {
    testApp = createTestApp();
    const cookie = await testApp.login();
    const [name, value] = cookie.split("=") as [string, string];
    const forged = `${name}=${value.slice(0, -2)}xx`;
    expect((await testApp.app.request("/api/tasks", { headers: { cookie: forged, host: TEST_HOST } })).status).toBe(401);
    expect((await testApp.app.request("/api/tasks", { headers: { cookie: `${name}=9999999999999.abc.def`, host: TEST_HOST } })).status).toBe(401);

    const other = createTestApp();
    expect((await other.app.request("/api/tasks", { headers: { cookie, host: TEST_HOST } })).status).toBe(401);
    other.close();

    expect((await testApp.app.request("/api/login", json({ password: 42 }))).status).toBe(400);
    expect((await testApp.app.request("/api/login", { method: "POST", headers: { host: TEST_HOST }, body: "nope" })).status).toBe(400);

    const logout = await testApp.app.request("/api/logout", { method: "POST", headers: { cookie, host: TEST_HOST } });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toMatch(/^auto_dev_session=; Max-Age=0; Path=\//);
  });

  it("refuses to log anyone in while the Installation has no password hash", async () => {
    testApp = createTestApp({ passwordHash: null });
    expect(await (await testApp.app.request("/api/session", { headers: { host: TEST_HOST } })).json()).toEqual({ authenticated: false, passwordSet: false });
    const response = await testApp.app.request("/api/login", json({ password: TEST_PASSWORD }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("AUTO_DEV_PASSWORD_HASH");
  });

  it("accepts only LAN-safe or listed Host values", async () => {
    testApp = createTestApp({ allowedHosts: ["auto-dev.example.com:8080"] });
    const cookie = await testApp.login();
    const status = async (host: string | undefined) => {
      const headers: Record<string, string> = { cookie };
      if (host !== undefined) headers.host = host;
      return (await testApp.app.request("/api/tasks", { headers })).status;
    };
    for (const host of ["192.168.1.10:8080", "10.0.0.5", "[::1]:8080", "localhost:8080", "auto-dev", "auto-dev.local", "AUTO-DEV.EXAMPLE.COM:9090"]) {
      expect(await status(host), host).toBe(200);
    }
    for (const host of ["evil.example.com", "auto-dev.example.org:8080", "", undefined]) {
      expect(await status(host), String(host)).toBe(403);
    }
    expect((await testApp.app.request("/api/health", { headers: { host: "evil.example.com" } })).status).toBe(403);
  });

  it("upgrades the WebSocket only with a session and an allowed Origin", async () => {
    testApp = createTestApp({ allowedHosts: ["auto-dev.example.com"] });
    server = await startServer({ app: testApp.app, host: "127.0.0.1", port: 0, log: testApp.log });
    const wsUrl = `${server.url.replace("http", "ws")}/ws`;
    const cookie = await testApp.login();

    expect(await handshakeStatus(wsUrl, { origin: server.url })).toBe(401);
    expect(await handshakeStatus(wsUrl, { cookie })).toBe(403);
    expect(await handshakeStatus(wsUrl, { cookie, origin: "http://evil.example.com" })).toBe(403);
    expect(await handshakeStatus(wsUrl, { cookie, origin: "http://evil.example.com", host: "evil.example.com" })).toBe(403);

    const client = await WsClient.connect(wsUrl, { cookie, origin: "http://auto-dev.example.com" });
    expect(await client.next()).toEqual({ type: "hello", version: "0.0.0-test" });
    await client.close();
  });
});
