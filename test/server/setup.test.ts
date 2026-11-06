import { afterEach, describe, expect, it } from "vitest";
import { parseEnvFile } from "../../src/config.js";
import type { SetupAccessResponse, SetupSmokeResponse, SetupStatus } from "../../src/server/app.js";
import { createTestApp, sessionCookieOf, TEST_ENV, TEST_ENV_FILE, TEST_HOST, TEST_PASSWORD, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("first-run wizard", () => {
  const apps: TestApp[] = [];
  afterEach(() => {
    for (const app of apps.splice(0)) app.close();
  });

  const fresh = () => {
    const app = createTestApp({ passwordHash: null, cloned: false });
    apps.push(app);
    return app;
  };

  const json = (body: unknown, cookie?: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", host: TEST_HOST, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

  const envFile = (app: TestApp) => parseEnvFile(app.files.read(TEST_ENV_FILE) ?? "");

  it("without an env file every entry leads to the wizard: the status is public, the API is closed", async () => {
    const app = fresh();
    const status = await app.app.request("/api/setup", { headers: { host: TEST_HOST } });
    expect(status.status).toBe(200);
    expect((await status.json()) as SetupStatus).toEqual({
      required: true,
      current: "password",
      steps: { password: false, repository: false, access: false, oauth: false, smoke: false, clone: false },
      passwordSet: false,
      repo: null,
      repoPath: "",
    });
    expect(await (await app.app.request("/api/session", { headers: { host: TEST_HOST } })).json()).toEqual({ authenticated: false, passwordSet: false });
    expect((await app.app.request("/api/tasks", { headers: { host: TEST_HOST } })).status).toBe(401);
    expect((await app.app.request("/api/settings", { headers: { host: TEST_HOST } })).status).toBe(401);
  });

  it("walks the steps in the order of the spec, stores each one in the env file right away and clones at the end", async () => {
    const app = fresh();
    const started: string[] = [];
    app.setup.onComplete(() => {
      started.push("orchestrator");
      void app.orchestrator.start();
    });

    // 1. password: the step works without a session and logs the human in
    const password = await app.app.request("/api/setup/password", json({ password: TEST_PASSWORD }));
    expect(password.status).toBe(200);
    const cookie = sessionCookieOf(password);
    expect((await password.json()) as SetupStatus).toMatchObject({ required: true, current: "repository", passwordSet: true });
    expect(envFile(app).AUTO_DEV_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
    expect(app.files.writes).toHaveLength(1);
    // from now on the steps are behind the login
    expect((await app.app.request("/api/setup/repository", json({ repo: "acme/product", token: "ghp_x" }))).status).toBe(401);
    const login = await app.app.request("/api/login", json({ password: TEST_PASSWORD }));
    expect(login.status).toBe(200);

    // 2. repository and token
    const repository = await app.app.request("/api/setup/repository", json({ repo: "acme/product", token: "github_pat_fine" }, cookie));
    expect(repository.status).toBe(200);
    expect((await repository.json()) as SetupStatus).toMatchObject({ current: "access", repo: "acme/product", repoPath: TEST_REPO_PATH });
    expect(envFile(app)).toMatchObject({ GITHUB_REPO: "acme/product", GITHUB_TOKEN: "github_pat_fine" });
    expect((await app.app.request("/api/setup/repository", json({ repo: "not a repo", token: "x" }, cookie))).status).toBe(400);

    // 3. access check with the stored token
    const access = await app.app.request("/api/setup/access", json({}, cookie));
    expect(access.status).toBe(200);
    expect((await access.json()) as SetupAccessResponse).toMatchObject({ ok: true, missing: [], access: { fullName: "example/product" }, status: { current: "oauth" } });
    expect(app.githubConfigs).toEqual([{ owner: "acme", repo: "product", token: "github_pat_fine" }]);

    // 4. OAuth token
    const oauth = await app.app.request("/api/setup/oauth", json({ token: "sk-ant-oat01-abc" }, cookie));
    expect((await oauth.json()) as SetupStatus).toMatchObject({ current: "smoke" });
    expect(envFile(app).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-abc");

    // 5. smoke query under that token
    const smoke = await app.app.request("/api/setup/smoke", json({}, cookie));
    expect((await smoke.json()) as SetupSmokeResponse).toMatchObject({ ok: true, claudeVersion: "2.1.318", status: { current: "clone" } });
    expect(app.ports.driver.smokeQueries).toEqual([{ cwd: "/var/lib/auto-dev", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" } }]);
    expect(started).toEqual([]);

    // 6. clone of the Product, then the Orchestrator starts without a restart
    const clone = await app.app.request("/api/setup/clone", json({}, cookie));
    expect(clone.status).toBe(200);
    expect((await clone.json()) as SetupStatus).toMatchObject({ required: false, current: "done" });
    expect(app.ports.worktree.calls.filter((call) => call.method === "clone")).toEqual([
      { method: "clone", args: [{ url: "https://github.com/acme/product.git", path: TEST_REPO_PATH }] },
    ]);
    expect(started).toEqual(["orchestrator"]);
    await flush();
    expect(app.ports.github.calls.map((call) => call.method)).toEqual(expect.arrayContaining(["getAuthenticatedUser", "listIssues"]));
    expect(app.orchestrator.running).toBe(true);
    const installation = await app.request("/api/installation");
    expect(((await installation.json()) as { product: unknown }).product).toEqual({ fullName: "acme/product", htmlUrl: "https://github.com/acme/product" });
  });

  it("resumes from the undone step after a restart, with the checks remembered", async () => {
    const first = fresh();
    const cookie = sessionCookieOf(await first.app.request("/api/setup/password", json({ password: TEST_PASSWORD })));
    await first.app.request("/api/setup/repository", json({ repo: "acme/product", token: "ghp_1" }, cookie));
    await first.app.request("/api/setup/access", json({}, cookie));
    await first.app.request("/api/setup/oauth", json({ token: "sk-ant-oat01-1" }, cookie));

    // the same env file and index, a new process
    const second = createTestApp({ files: first.files, index: first.index, cloned: false });
    const status = (await (await second.request("/api/setup")).json()) as SetupStatus;
    expect(status).toMatchObject({
      required: true,
      current: "smoke",
      steps: { password: true, repository: true, access: true, oauth: true, smoke: false, clone: false },
      repo: "acme/product",
    });
    // the old password still opens the door
    expect((await second.app.request("/api/login", json({ password: TEST_PASSWORD }))).status).toBe(200);
    second.orchestrator.stop();
  });

  it("a half-filled env file also leads to the wizard, and a changed token wants its check again", async () => {
    const app = createTestApp({ env: { GITHUB_REPO: "acme/product", GITHUB_TOKEN: "ghp_a" } });
    apps.push(app);
    expect((await (await app.request("/api/setup")).json()) as SetupStatus).toMatchObject({ required: true, current: "access", passwordSet: true });
    await app.request("/api/setup/access", json({}));
    expect((await (await app.request("/api/setup")).json()) as SetupStatus).toMatchObject({ current: "oauth" });
    await app.request("/api/setup/repository", json({ repo: "acme/product", token: "ghp_b" }));
    expect((await (await app.request("/api/setup")).json()) as SetupStatus).toMatchObject({ current: "access" });
  });

  it("rejects a token without the needed permissions and keeps the wizard on the access step", async () => {
    const app = createTestApp({ env: { GITHUB_REPO: "acme/product", GITHUB_TOKEN: "ghp_weak" }, cloned: false });
    apps.push(app);
    app.ports.github.access.permissions.issuesWrite = false;
    app.ports.github.access.permissions.pullRequestsWrite = false;
    const response = await app.request("/api/setup/access", json({}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as SetupAccessResponse;
    expect(body).toMatchObject({ ok: false, missing: ["issuesWrite", "pullRequestsWrite"], status: { current: "access" } });
    expect(body.error).toContain("Issues: write");
    expect(body.error).toContain("Pull requests: write");

    app.ports.github.access.permissions = {
      metadataRead: false,
      contentsWrite: false,
      issuesWrite: false,
      pullRequestsWrite: false,
      actionsRead: false,
      statusesRead: false,
    };
    expect((await (await app.request("/api/setup/access", json({}))).json()) as SetupAccessResponse).toMatchObject({ ok: false, status: { current: "access" } });
  });

  it("does not let a rejected OAuth token past the smoke query", async () => {
    const app = createTestApp({ env: { ...TEST_ENV }, cloned: false });
    apps.push(app);
    await app.request("/api/setup/access", json({}));
    app.ports.driver.scriptSmokeQuery({ ok: false, error: "authentication_failed: OAuth token revoked" });
    const failed = (await (await app.request("/api/setup/smoke", json({}))).json()) as SetupSmokeResponse;
    expect(failed).toMatchObject({ ok: false, error: "authentication_failed: OAuth token revoked", status: { current: "smoke" } });
    expect((await app.request("/api/setup/clone", json({}))).status).toBe(200);
    // the clone step itself works, but the wizard still waits for the smoke query
    expect((await (await app.request("/api/setup")).json()) as SetupStatus).toMatchObject({ required: true, current: "smoke" });

    const passed = (await (await app.request("/api/setup/smoke", json({}))).json()) as SetupSmokeResponse;
    expect(passed).toMatchObject({ ok: true, status: { required: false, current: "done" } });
  });

  it("answers 400 to malformed bodies and to steps whose prerequisites are missing", async () => {
    const app = fresh();
    expect((await app.app.request("/api/setup/password", json({ password: "   " }))).status).toBe(400);
    expect((await app.app.request("/api/setup/password", { method: "POST", headers: { host: TEST_HOST }, body: "nope" })).status).toBe(400);
    expect((await app.app.request("/api/setup/access", json({}))).status).toBe(400);
    expect((await app.app.request("/api/setup/smoke", json({}))).status).toBe(400);
    expect((await app.app.request("/api/setup/clone", json({}))).status).toBe(400);
  });
});
