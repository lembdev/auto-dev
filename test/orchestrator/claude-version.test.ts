import { afterEach, describe, expect, it } from "vitest";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import { INSTALLATION_KEYS } from "../../src/orchestrator/orchestrator.js";
import { createTestApp, TEST_DATA_DIR, TEST_ENV, type TestApp } from "../helpers/test-app.js";

const SESSION = "44444444-4444-4444-8444-444444444444" as SessionId;
const FIRST = 1 as IssueNumber;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const takenIssues = (testApp: TestApp): number[] =>
  testApp.ports.github.calls.filter((call) => call.method === "addAssignees").map((call) => call.args[0] as number);

describe("the version of claude under the Installation", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  const scenario = (options: { maxParallelTasks?: number; env?: Record<string, string> } = {}): TestApp => {
    const testApp = createTestApp(options.env ? { env: options.env } : {});
    open.push(testApp);
    testApp.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, String(options.maxParallelTasks ?? 1));
    testApp.ports.github.seedIssue({ number: 1, title: "First", labels: ["ready-for-agent"] });
    testApp.ports.github.seedIssue({ number: 2, title: "Second", labels: ["ready-for-agent"] });
    return testApp;
  };

  const versionView = (testApp: TestApp) => testApp.orchestrator.installation.snapshot().claudeVersion;

  it("records the first version seen as the last known good one without a smoke query", async () => {
    const s = scenario();
    await s.orchestrator.pollOnce();
    expect(s.ports.driver.smokeQueries).toHaveLength(0);
    expect(versionView(s)).toMatchObject({ current: "2.1.318", lastKnownGood: "2.1.318", status: "ok", error: null, rollbackCommand: null });
    expect(takenIssues(s)).toEqual([1]);
  });

  it("runs one smoke query when the version changes and keeps the new version after it passes", async () => {
    const s = scenario();
    await s.orchestrator.pollOnce();
    const before = s.ports.driver.calls.filter((call) => call.method === "getClaudeVersion").length;

    s.ports.driver.claudeVersion = "2.2.0";
    await s.orchestrator.pollOnce();
    expect(s.ports.driver.smokeQueries).toEqual([{ cwd: TEST_DATA_DIR }]);
    expect(versionView(s)).toMatchObject({ current: "2.2.0", lastKnownGood: "2.2.0", status: "ok" });
    expect(s.orchestrator.canStartTurn()).toBe(true);

    // The version is read once per cycle and the smoke query does not repeat on an unchanged version.
    await s.orchestrator.pollOnce();
    expect(s.ports.driver.calls.filter((call) => call.method === "getClaudeVersion")).toHaveLength(before + 2);
    expect(s.ports.driver.smokeQueries).toHaveLength(1);
  });

  it("blocks new Agents after a failed smoke query, leaves live ones alone and names the rollback command", async () => {
    const s = scenario();
    await s.orchestrator.pollOnce();
    expect(takenIssues(s)).toEqual([1]);
    const process = s.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));

    s.ports.driver.claudeVersion = "2.2.0";
    s.ports.driver.scriptSmokeQuery({ ok: false, error: "Claude Code process exited with code 1" });
    s.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, "2");
    await s.orchestrator.pollOnce();

    expect(s.orchestrator.canStartTurn()).toBe(false);
    expect(s.orchestrator.installation.snapshot()).toMatchObject({
      paused: false,
      blocker: "claude_version",
      canStartTurn: false,
      claudeVersion: {
        current: "2.2.0",
        lastKnownGood: "2.1.318",
        status: "failed",
        error: "Claude Code process exited with code 1",
        rollbackCommand: "claude install 2.1.318",
      },
    });
    expect(takenIssues(s)).toEqual([1]);
    expect(process.calls.map((call) => call.method)).not.toContain("stop");

    // The live Implementer finishes its Turn as usual; the QA round that follows waits.
    process.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();
    expect(s.index.tasks.get(FIRST).stage).toBe("qa");
    await s.orchestrator.pollOnce();
    expect(s.ports.driver.launches).toHaveLength(1);
    expect(s.ports.driver.smokeQueries).toHaveLength(1);
  });

  it("tries again only when the version changes once more", async () => {
    const s = scenario();
    await s.orchestrator.pollOnce();
    s.ports.driver.claudeVersion = "2.2.0";
    s.ports.driver.scriptSmokeQuery({ ok: false, error: "boom" });
    await s.orchestrator.pollOnce();
    await s.orchestrator.pollOnce();
    expect(s.ports.driver.smokeQueries).toHaveLength(1);
    expect(versionView(s).status).toBe("failed");

    s.ports.driver.claudeVersion = "2.2.1";
    await s.orchestrator.pollOnce();
    expect(s.ports.driver.smokeQueries).toHaveLength(2);
    expect(versionView(s)).toMatchObject({ current: "2.2.1", lastKnownGood: "2.2.1", status: "ok", rollbackCommand: null });
    expect(s.orchestrator.canStartTurn()).toBe(true);
  });

  it("tries again on a manual recheck of the same version", async () => {
    const s = scenario();
    await s.orchestrator.pollOnce();
    s.ports.driver.claudeVersion = "2.2.0";
    s.ports.driver.scriptSmokeQuery({ ok: false, error: "boom" });
    await s.orchestrator.pollOnce();
    expect(s.orchestrator.canStartTurn()).toBe(false);

    const view = await s.orchestrator.installation.claudeVersion.recheck();
    expect(s.ports.driver.smokeQueries).toHaveLength(2);
    expect(view).toMatchObject({ current: "2.2.0", lastKnownGood: "2.2.0", status: "ok", error: null });
    expect(s.orchestrator.canStartTurn()).toBe(true);
  });

  it("lifts the block without a smoke query once claude is rolled back to the last known good version", async () => {
    const s = scenario();
    await s.orchestrator.pollOnce();
    s.ports.driver.claudeVersion = "2.2.0";
    s.ports.driver.scriptSmokeQuery({ ok: false, error: "boom" });
    await s.orchestrator.pollOnce();
    expect(takenIssues(s)).toEqual([1]);

    s.ports.driver.claudeVersion = "2.1.318";
    s.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, "2");
    await s.orchestrator.pollOnce();
    expect(s.ports.driver.smokeQueries).toHaveLength(1);
    expect(versionView(s)).toMatchObject({ current: "2.1.318", lastKnownGood: "2.1.318", status: "ok" });
    expect(takenIssues(s)).toEqual([1, 2]);
  });

  it("survives a restart: a failed version stays blocked, a good one needs no new smoke query", async () => {
    const s = scenario();
    await s.orchestrator.pollOnce();
    s.ports.driver.claudeVersion = "2.2.0";
    s.ports.driver.scriptSmokeQuery({ ok: false, error: "boom" });
    await s.orchestrator.pollOnce();
    s.orchestrator.stop();

    const restarted = createTestApp({ files: s.files, index: s.index });
    restarted.ports.driver.claudeVersion = "2.2.0";
    await restarted.orchestrator.pollOnce();
    expect(restarted.ports.driver.smokeQueries).toHaveLength(0);
    expect(restarted.orchestrator.installation.snapshot()).toMatchObject({ blocker: "claude_version", claudeVersion: { status: "failed", rollbackCommand: "claude install 2.1.318" } });
    restarted.orchestrator.stop();
  });

  it("blocks new Agents when claude does not report a version at all", async () => {
    const s = scenario();
    await s.orchestrator.pollOnce();
    s.ports.driver.getClaudeVersion = async () => {
      throw new Error("spawn claude ENOENT");
    };
    s.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, "2");
    await s.orchestrator.pollOnce();
    expect(takenIssues(s)).toEqual([1]);
    expect(versionView(s)).toMatchObject({ current: null, lastKnownGood: "2.1.318", status: "failed", rollbackCommand: "claude install 2.1.318" });
    expect(versionView(s).error).toContain("spawn claude ENOENT");
    expect(s.ports.driver.smokeQueries).toHaveLength(0);
  });

  describe("an expired OAuth token", () => {
    it("pauses with the token as the source and tells the human where to store a new one", async () => {
      const s = scenario();
      await s.orchestrator.pollOnce();
      const process = s.ports.driver.lastLaunch();
      process.emit(sdkMessages.init(SESSION));
      process.emit(sdkMessages.apiRetry(SESSION, "authentication_failed"));
      await flush();
      expect(s.orchestrator.installation.findPause()).toMatchObject({ source: "token" });
      expect(s.orchestrator.installation.findPause()?.reason).toContain("Settings");
      expect(process.calls.map((call) => call.method)).not.toContain("stop");
      expect(s.orchestrator.canStartTurn()).toBe(false);
    });

    it("ends with a new token stored on the Settings page, which also clears a smoke failure caused by the token", async () => {
      const s = scenario({ env: TEST_ENV });
      await s.orchestrator.pollOnce();
      const process = s.ports.driver.lastLaunch();
      process.emit(sdkMessages.init(SESSION));
      process.emit(sdkMessages.apiRetry(SESSION, "authentication_failed"));
      await flush();
      s.ports.driver.claudeVersion = "2.2.0";
      s.ports.driver.scriptSmokeQuery({ ok: false, error: "authentication_failed" });
      await s.orchestrator.pollOnce();
      expect(s.orchestrator.installation.snapshot()).toMatchObject({ paused: true, blocker: "paused", claudeVersion: { status: "failed" } });

      const response = await s.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oauthToken: "sk-ant-oat01-fresh" }),
      });
      expect(response.status).toBe(200);
      expect(s.ports.driver.smokeQueries.at(-1)?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fresh" });
      expect(s.orchestrator.installation.snapshot()).toMatchObject({
        paused: false,
        blocker: null,
        canStartTurn: true,
        claudeVersion: { lastKnownGood: "2.2.0", status: "ok", error: null },
      });
    });

    it("keeps a token Pause when only the GitHub token changes", async () => {
      const s = scenario({ env: TEST_ENV });
      s.orchestrator.installation.pause("token", "rejected");
      const response = await s.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubToken: "github_pat_new" }),
      });
      expect(response.status).toBe(200);
      expect(s.orchestrator.installation.findPause()?.source).toBe("token");
    });
  });
});
