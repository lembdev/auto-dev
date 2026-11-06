import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, TEST_HOST, type TestApp } from "../helpers/test-app.js";

describe("the client bundle", () => {
  let testApp: TestApp;
  let dir: string | undefined;

  afterEach(() => {
    testApp?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is served from the client dir with an SPA fallback, while the API keeps its JSON 404", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-client-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>auto-dev</title>");
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    testApp = createTestApp({ clientDir: dir });
    const host = { host: TEST_HOST };

    const index = await testApp.app.request("/", { headers: host });
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("<title>auto-dev</title>");

    const asset = await testApp.app.request("/assets/app.js", { headers: host });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log(1)");

    const route = await testApp.app.request("/tasks/42", { headers: host });
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<title>auto-dev</title>");

    const api = await testApp.request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not found" });
    expect((await testApp.app.request("/", { headers: { host: "evil.example.com" } })).status).toBe(403);
  });

  it("answers 404 for pages when there is no client dir", async () => {
    testApp = createTestApp();
    expect((await testApp.app.request("/", { headers: { host: TEST_HOST } })).status).toBe(404);
  });
});
