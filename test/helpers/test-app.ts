import { Writable } from "node:stream";
import { createFakePorts, type FakePorts } from "../../src/fakes/index.js";
import { IN_MEMORY, openRuntimeIndex, type RuntimeIndex } from "../../src/index/runtime-index.js";
import { createLogger, type LogLevel, type Logger } from "../../src/log.js";
import { Orchestrator, type OrchestratorHooks } from "../../src/orchestrator/orchestrator.js";
import { createApp, type App } from "../../src/server/app.js";

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
  allowedHosts?: string[];
  clientDir?: string;
};

export const TEST_PASSWORD = "correct horse";
// argon2id of TEST_PASSWORD with the cheapest parameters, so login in tests costs nothing.
export const TEST_PASSWORD_HASH = "$argon2id$v=19$m=4096,t=1,p=1$HNt/zqFtXqwZ75O22IuPbA$tBn0zfSFnnvUVAxgPKIE59tNWIh1zioPywQ2fmuw8eM";
export const TEST_HOST = "192.168.1.10:8080";

// Where the fakes pretend the Installation keeps its data and the Product is cloned.
export const TEST_DATA_DIR = "/var/lib/auto-dev";
export const TEST_REPO_PATH = `${TEST_DATA_DIR}/repo`;

// The server and the Orchestrator on fakes and an in-memory index: the seam every scenario test goes through.
// The Orchestrator is not started; tests call `pollOnce()` or `start()` themselves.
export function createTestApp(options: TestAppOptions = {}): TestApp {
  const ports = createFakePorts();
  ports.worktree.seedRepo(TEST_REPO_PATH);
  const index = openRuntimeIndex(IN_MEMORY);
  const sink = createLogSink();
  const log = createLogger({ level: options.logLevel ?? "silent", destination: sink });
  const product = { repoPath: TEST_REPO_PATH };
  const dataDir = TEST_DATA_DIR;
  const orchestrator = new Orchestrator(
    options.hooks ? { ports, index, log, hooks: options.hooks, product, dataDir } : { ports, index, log, product, dataDir },
  );
  const app = createApp({
    ports,
    index,
    log,
    version: options.version ?? "0.0.0-test",
    orchestrator,
    auth: { passwordHash: options.passwordHash === null ? undefined : (options.passwordHash ?? TEST_PASSWORD_HASH), allowedHosts: options.allowedHosts ?? [] },
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
