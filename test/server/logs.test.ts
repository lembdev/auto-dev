import { afterEach, describe, expect, it } from "vitest";
import { LogBuffer } from "../../src/log.js";
import type { LogsResponse } from "../../src/server/app.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("GET /api/logs", () => {
  let testApp: TestApp;
  afterEach(() => {
    testApp?.orchestrator.stop();
    testApp?.close();
  });

  const logs = async (query = ""): Promise<LogsResponse> => {
    const response = await testApp.request(`/api/logs${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as LogsResponse;
  };

  it("is empty before anything was logged", async () => {
    testApp = createTestApp();
    expect(await logs()).toEqual({ lines: 500, source: "buffer", entries: [] });
  });

  it("returns the last lines of the Orchestrator journal, oldest first, parsed", async () => {
    testApp = createTestApp({ logLevel: "info" });
    // The login itself is logged; it must land before the lines the test is about.
    await testApp.login();
    testApp.log.info({ issue: 7 }, "task taken");
    testApp.log.warn("poll failed");
    testApp.log.debug("hidden by the level");
    testApp.log.flush?.();
    await flush();

    const body = await logs();
    expect(body.source).toBe("buffer");
    expect(body.entries.map((entry) => entry.msg)).toEqual(["task taken", "poll failed"]);
    expect(body.entries[0]).toMatchObject({ level: "info", msg: "task taken" });
    expect(body.entries[1]).toMatchObject({ level: "warn" });
    expect(typeof body.entries[0]?.at).toBe("string");
    expect(JSON.parse(body.entries[0]!.raw)).toMatchObject({ issue: 7, msg: "task taken" });
  });

  it("keeps only the requested tail and caps the request at 500 lines", async () => {
    testApp = createTestApp({ logLevel: "info" });
    await testApp.login();
    for (let i = 0; i < 20; i += 1) testApp.log.info(`line ${i}`);
    testApp.log.flush?.();
    await flush();

    const tail = await logs("?lines=3");
    expect(tail.lines).toBe(3);
    expect(tail.entries.map((entry) => entry.msg)).toEqual(["line 17", "line 18", "line 19"]);
    expect((await logs("?lines=5000")).lines).toBe(500);
    expect((await testApp.request("/api/logs?lines=0")).status).toBe(400);
    expect((await testApp.request("/api/logs?lines=many")).status).toBe(400);
  });
});

describe("LogBuffer", () => {
  it("keeps the last `capacity` lines and splits chunks on newlines", async () => {
    const buffer = new LogBuffer(3);
    buffer.write('{"msg":"a"}\n{"msg":"b"}\n');
    buffer.write('{"msg":"c"}\n');
    buffer.write('{"msg":"d"}\n');
    expect(await buffer.tail(10)).toEqual({ source: "buffer", lines: ['{"msg":"b"}', '{"msg":"c"}', '{"msg":"d"}'] });
    expect(await buffer.tail(2)).toEqual({ source: "buffer", lines: ['{"msg":"c"}', '{"msg":"d"}'] });
  });
});
