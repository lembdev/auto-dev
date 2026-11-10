import { afterEach, describe, expect, it } from "vitest";
import { parseEnvFile } from "../../src/config.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import type { SettingsResponse } from "../../src/server/app.js";
import { createTestApp, sessionCookieOf, TEST_ENV, TEST_ENV_FILE, TEST_HOST, TEST_PASSWORD, type TestApp } from "../helpers/test-app.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as SessionId;
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as SessionId;

describe("/api/settings", () => {
  let app: TestApp;
  afterEach(() => {
    app?.close();
  });

  const configured = () => {
    app = createTestApp({ env: { ...TEST_ENV } });
    return app;
  };

  const get = async (): Promise<SettingsResponse> => {
    const response = await app.request("/api/settings");
    expect(response.status).toBe(200);
    return (await response.json()) as SettingsResponse;
  };

  const put = (body: unknown) =>
    app.request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  const envFile = () => parseEnvFile(app.files.read(TEST_ENV_FILE) ?? "");

  it("shows the numbers from `installation` with their defaults and which secrets are stored", async () => {
    configured();
    expect(await get()).toEqual({
      maxParallelTasks: 2,
      prearmEnabled: true,
      maxQaRounds: 3,
      model: null,
      repo: "acme/product",
      secrets: { githubToken: true, oauthToken: true, password: true },
    });
    app.index.installation.set("max_parallel_tasks", "5");
    expect((await get()).maxParallelTasks).toBe(5);
  });

  it("changes max_parallel_tasks, pre-arm and the round limit without a restart", async () => {
    configured();
    const response = await put({ maxParallelTasks: 4, prearmEnabled: false, maxQaRounds: 5 });
    expect(response.status).toBe(200);
    expect((await response.json()) as SettingsResponse).toMatchObject({ maxParallelTasks: 4, prearmEnabled: false, maxQaRounds: 5 });
    expect(app.index.installation.all()).toMatchObject({ max_parallel_tasks: "4", prearm_enabled: "false", max_qa_rounds: "5" });
    expect(app.orchestrator.slots()).toEqual({ used: 0, max: 4 });
    expect(app.orchestrator.qa.maxRounds()).toBe(5);
    expect(app.orchestrator.installation.prearmEnabled()).toBe(false);
    expect(app.files.writes).toHaveLength(0);
    const tasks = (await (await app.request("/api/tasks")).json()) as { slots: unknown; maxQaRounds: number };
    expect(tasks).toMatchObject({ slots: { used: 0, max: 4 }, maxQaRounds: 5 });
  });

  it("lists the models of the subscription and launches the next Agent with the chosen one", async () => {
    configured();
    const models = (await (await app.request("/api/settings/models")).json()) as { models: { value: string }[]; error: string | null };
    expect(models.error).toBeNull();
    expect(models.models.map((model) => model.value)).toEqual(["default", "opus", "haiku"]);

    const response = await put({ model: "opus" });
    expect(response.status).toBe(200);
    expect((await response.json()) as SettingsResponse).toMatchObject({ model: "opus" });
    expect(app.index.installation.all()).toMatchObject({ agent_model: "opus" });

    app.ports.github.seedIssue({ number: 42, title: "Add login", body: "A login form.", labels: ["ready-for-agent"] });
    await app.orchestrator.pollOnce();
    expect(app.ports.driver.lastLaunch().launch.model).toBe("opus");
  });

  it("goes back to the CLI default and launches without a model", async () => {
    configured();
    await put({ model: "haiku" });
    expect((await (await put({ model: "default" })).json()) as SettingsResponse).toMatchObject({ model: null });
    expect(app.index.installation.all()).not.toHaveProperty("agent_model");
    await put({ model: "haiku" });
    expect((await (await put({ model: null })).json()) as SettingsResponse).toMatchObject({ model: null });

    app.ports.github.seedIssue({ number: 42, title: "Add login", body: "A login form.", labels: ["ready-for-agent"] });
    await app.orchestrator.pollOnce();
    expect(app.ports.driver.lastLaunch().launch).not.toHaveProperty("model");
  });

  it("refuses a model the subscription does not list, and takes any when the list is unavailable", async () => {
    configured();
    expect((await put({ model: "gpt-5" })).status).toBe(400);
    expect((await get()).model).toBeNull();

    app.close();
    app = createTestApp({ env: { ...TEST_ENV } });
    app.ports.driver.modelsError = new Error("claude did not list the models");
    const models = (await (await app.request("/api/settings/models")).json()) as { models: unknown[]; error: string | null };
    expect(models).toEqual({ models: [], error: "claude did not list the models" });
    expect((await put({ model: "sonnet" })).status).toBe(200);
    expect((await get()).model).toBe("sonnet");
  });

  it("rejects bad values and leaves everything as it was", async () => {
    configured();
    for (const body of [{ maxParallelTasks: -1 }, { maxParallelTasks: 1.5 }, { maxQaRounds: 0 }, { prearmEnabled: "yes" }, { model: "" }, { model: 5 }, { githubToken: "" }, { password: " " }, "nope"]) {
      const response = await put(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await get()).toMatchObject({ maxParallelTasks: 2, prearmEnabled: true, maxQaRounds: 3 });
    expect(app.files.writes).toHaveLength(0);
  });

  it("stores a new GitHub token after its access check, rewrites the env file and restarts live Agents at the end of their Turn", async () => {
    configured();
    const runner = app.orchestrator.agents;
    const idle = runner.start({ issueNumber: 7 as IssueNumber, role: "implementer", cwd: "/w/7", prompt: "implement #7" });
    const idleProcess = app.ports.driver.lastLaunch();
    idleProcess.emit(sdkMessages.init(SESSION_A));
    idleProcess.emit(sdkMessages.resultSuccess(SESSION_A, "done"));
    const busy = runner.start({ issueNumber: 8 as IssueNumber, role: "qa", cwd: "/w/8", prompt: "review #8" });
    const busyProcess = app.ports.driver.lastLaunch();
    busyProcess.emit(sdkMessages.init(SESSION_B));
    await flush();

    const response = await put({ githubToken: "github_pat_new" });
    expect(response.status).toBe(200);
    expect(app.githubConfigs).toEqual([{ owner: "acme", repo: "product", token: "github_pat_new" }]);
    expect(envFile()).toMatchObject({ GITHUB_TOKEN: "github_pat_new", GITHUB_REPO: "acme/product", CLAUDE_CODE_OAUTH_TOKEN: TEST_ENV.CLAUDE_CODE_OAUTH_TOKEN });
    expect(app.config.current().github?.token).toBe("github_pat_new");

    await flush();
    expect(app.index.agents.get(idle.id)).toMatchObject({ state: "stopped", sessionId: SESSION_A });
    expect(app.index.agents.get(busy.id).state).toBe("running");
    busyProcess.emit(sdkMessages.resultSuccess(SESSION_B, "verdict"));
    await flush();
    await flush();
    expect(app.index.agents.get(busy.id)).toMatchObject({ state: "stopped", sessionId: SESSION_B });

    // the next message resumes the Session in a new process
    await runner.send(idle.id, "fix the blockers");
    expect(app.ports.driver.lastLaunch().launch).toMatchObject({ resume: SESSION_A, prompt: "fix the blockers" });
  });

  it("refuses a GitHub token that fails the access check and keeps the old one", async () => {
    configured();
    app.ports.github.access.permissions.contentsWrite = false;
    const response = await put({ githubToken: "github_pat_weak" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("Contents: write");
    expect(envFile().GITHUB_TOKEN).toBe("ghp_test");
    expect(app.files.writes).toHaveLength(0);
  });

  it("stores a new OAuth token after a smoke query and lifts a Pause caused by the old token", async () => {
    configured();
    app.orchestrator.installation.pause("token", "the Claude OAuth token was rejected");
    app.ports.driver.scriptSmokeQuery({ ok: false, error: "authentication_failed" });
    const rejected = await put({ oauthToken: "sk-ant-oat01-bad" });
    expect(rejected.status).toBe(400);
    expect(envFile().CLAUDE_CODE_OAUTH_TOKEN).toBe(TEST_ENV.CLAUDE_CODE_OAUTH_TOKEN);
    expect(app.orchestrator.installation.paused()).toBe(true);

    const accepted = await put({ oauthToken: "sk-ant-oat01-good" });
    expect(accepted.status).toBe(200);
    expect(app.ports.driver.smokeQueries.map((query) => query.env?.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["sk-ant-oat01-bad", "sk-ant-oat01-good"]);
    expect(envFile().CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-good");
    expect(app.orchestrator.installation.paused()).toBe(false);
    expect(app.setup.smokeVerified()).toBe(true);
  });

  it("keeps a human Pause when a token changes", async () => {
    configured();
    app.orchestrator.installation.pause("human", "holiday");
    expect((await put({ oauthToken: "sk-ant-oat01-good" })).status).toBe(200);
    expect(app.orchestrator.installation.findPause()?.source).toBe("human");
  });

  it("changes the password: the new one logs in, the old one does not, open sessions stay", async () => {
    configured();
    expect((await put({ password: "new pass phrase" })).status).toBe(200);
    expect(envFile().AUTO_DEV_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
    const login = (password: string) =>
      app.app.request("/api/login", { method: "POST", headers: { "content-type": "application/json", host: TEST_HOST }, body: JSON.stringify({ password }) });
    expect((await login(TEST_PASSWORD)).status).toBe(401);
    const fresh = await login("new pass phrase");
    expect(fresh.status).toBe(200);
    expect(sessionCookieOf(fresh)).toContain("auto_dev_session=");
    expect((await app.request("/api/settings")).status).toBe(200);
  });
});
