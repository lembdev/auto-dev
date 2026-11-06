import argon2 from "argon2";
import { Writable } from "node:stream";
import { ConfigStore, MemoryEnvFileAccess, patchEnvFile } from "../../src/config-store.js";
import type { GitHubConfig } from "../../src/config.js";
import { createFakePorts, type FakePorts } from "../../src/fakes/index.js";
import { IN_MEMORY, openRuntimeIndex, type RuntimeIndex } from "../../src/index/runtime-index.js";
import { createLogger, type LogLevel, type Logger } from "../../src/log.js";
import { Orchestrator, type OrchestratorHooks } from "../../src/orchestrator/orchestrator.js";
import { createApp, type App } from "../../src/server/app.js";
import { Settings } from "../../src/setup/settings.js";
import { Setup } from "../../src/setup/setup.js";

export type LogSink = Writable & { lines(): Record<string, unknown>[] };

// Collects pino JSON lines so tests can assert on what was logged.
export function createLogSink(): LogSink {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as LogSink;
  sink.lines = () =>
    chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return sink;
}

export type TestApp = {
  app: App;
  ports: FakePorts;
  index: RuntimeIndex;
  orchestrator: Orchestrator;
  config: ConfigStore;
  // The in-memory env file of the Installation; `files.read(TEST_ENV_FILE)` is what the wizard wrote.
  files: MemoryEnvFileAccess;
  setup: Setup;
  settings: Settings;
  // Token and repository every GitHub port built for a check was given, in order.
  githubConfigs: GitHubConfig[];
  log: Logger;
  sink: LogSink;
  // Logs in with the test password and returns the `Cookie` header of the session.
  login(): Promise<string>;
  // `app.request` with a logged-in session and a LAN `Host`; the way scenario tests call the API.
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): void;
};

export type TestAppOptions = {
  logLevel?: LogLevel;
  version?: string;
  hooks?: OrchestratorHooks;
  // undefined keeps the test password; null leaves the Installation without a password.
  passwordHash?: string | null;
  // Further lines of the env file, e.g. GITHUB_REPO and the tokens of a configured Installation.
  env?: Record<string, string>;
  // Whether the fake Product clone exists from the start.
  cloned?: boolean;
  allowedHosts?: string[];
  clientDir?: string;
  // A restart of the same Installation: the env file and the index of a previous test app.
  files?: MemoryEnvFileAccess;
  index?: RuntimeIndex;
};

export const TEST_PASSWORD = "correct horse";
// argon2id of TEST_PASSWORD with the cheapest parameters, so login in tests costs nothing.
export const TEST_PASSWORD_HASH = "$argon2id$v=19$m=4096,t=1,p=1$HNt/zqFtXqwZ75O22IuPbA$tBn0zfSFnnvUVAxgPKIE59tNWIh1zioPywQ2fmuw8eM";
export const TEST_HOST = "192.168.1.10:8080";

// Where the fakes pretend the Installation keeps its data and the Product is cloned.
export const TEST_DATA_DIR = "/var/lib/auto-dev";
export const TEST_REPO_PATH = `${TEST_DATA_DIR}/repo`;
export const TEST_ENV_FILE = "/etc/auto-dev/env";

// A configured Installation, as the wizard leaves it.
export const TEST_ENV = { GITHUB_REPO: "acme/product", GITHUB_TOKEN: "ghp_test", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" };

// argon2id with the cheapest parameters: the wizard and the Settings page hash in tests too.
export const cheapHash = (password: string): Promise<string> => argon2.hash(password, { memoryCost: 4096, timeCost: 1, parallelism: 1 });

// The server and the Orchestrator on fakes and an in-memory index: the seam every scenario test goes through.
// The Orchestrator is not started; tests call `pollOnce()` or `start()` themselves.
export function createTestApp(options: TestAppOptions = {}): TestApp {
  const ports = createFakePorts();
  if (options.cloned ?? true) ports.worktree.seedRepo(TEST_REPO_PATH);
  const index = options.index ?? openRuntimeIndex(IN_MEMORY);
  const passwordHash = options.passwordHash === null ? undefined : (options.passwordHash ?? TEST_PASSWORD_HASH);
  const envValues = { ...(passwordHash ? { AUTO_DEV_PASSWORD_HASH: passwordHash } : {}), ...options.env };
  const files = options.files ?? new MemoryEnvFileAccess(Object.keys(envValues).length > 0 ? { [TEST_ENV_FILE]: patchEnvFile(undefined, envValues) } : {});
  const config = new ConfigStore({ files, env: { AUTO_DEV_ENV_FILE: TEST_ENV_FILE, AUTO_DEV_DATA_DIR: TEST_DATA_DIR } });
  const githubConfigs: GitHubConfig[] = [];
  const sink = createLogSink();
  const log = createLogger({ level: options.logLevel ?? "silent", destination: sink });
  const product = { repoPath: TEST_REPO_PATH };
  const dataDir = TEST_DATA_DIR;
  const orchestrator = new Orchestrator(
    options.hooks ? { ports, index, log, hooks: options.hooks, product, dataDir } : { ports, index, log, product, dataDir },
  );
  const setup = new Setup({
    config,
    installation: index.installation,
    worktree: ports.worktree,
    driver: ports.driver,
    github: (github) => {
      githubConfigs.push(github);
      return ports.github;
    },
    log,
    hashPassword: cheapHash,
  });
  const settings = new Settings({
    config,
    installation: index.installation,
    state: orchestrator.installation,
    runner: orchestrator.agents,
    qa: orchestrator.qa,
    maxParallelTasks: () => orchestrator.maxParallelTasks(),
    setup,
    log,
    hashPassword: cheapHash,
  });
  const app = createApp({
    ports,
    index,
    log,
    version: options.version ?? "0.0.0-test",
    orchestrator,
    config,
    setup,
    settings,
    auth: { allowedHosts: options.allowedHosts ?? [] },
    ...(options.clientDir !== undefined ? { clientDir: options.clientDir } : {}),
  });
  let cookie: string | undefined;
  const login = async (): Promise<string> => {
    if (cookie !== undefined) return cookie;
    const response = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", host: TEST_HOST },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    if (response.status !== 200) throw new Error(`test login failed with ${response.status}`);
    cookie = sessionCookieOf(response);
    return cookie;
  };
  return {
    app,
    ports,
    index,
    orchestrator,
    config,
    files,
    setup,
    settings,
    githubConfigs,
    log,
    sink,
    login,
    request: async (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", await login());
      if (!headers.has("host")) headers.set("host", TEST_HOST);
      return app.request(path, { ...init, headers });
    },
    close: () => {
      orchestrator.stop();
      index.close();
    },
  };
}

// The `name=value` pair of the session cookie set by a login response.
export function sessionCookieOf(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("no Set-Cookie header in the response");
  return header.split(";")[0] as string;
}
