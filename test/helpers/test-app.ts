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
  close(): void;
};

export type TestAppOptions = {
  logLevel?: LogLevel;
  version?: string;
  hooks?: OrchestratorHooks;
};

// Where the fakes pretend the Product is cloned.
export const TEST_REPO_PATH = "/var/lib/auto-dev/repo";

// The server and the Orchestrator on fakes and an in-memory index: the seam every scenario test goes through.
// The Orchestrator is not started; tests call `pollOnce()` or `start()` themselves.
export function createTestApp(options: TestAppOptions = {}): TestApp {
  const ports = createFakePorts();
  ports.worktree.seedRepo(TEST_REPO_PATH);
  const index = openRuntimeIndex(IN_MEMORY);
  const sink = createLogSink();
  const log = createLogger({ level: options.logLevel ?? "silent", destination: sink });
  const product = { repoPath: TEST_REPO_PATH };
  const orchestrator = new Orchestrator(
    options.hooks ? { ports, index, log, hooks: options.hooks, product } : { ports, index, log, product },
  );
  const app = createApp({ ports, index, log, version: options.version ?? "0.0.0-test", orchestrator });
  return {
    app,
    ports,
    index,
    orchestrator,
    log,
    sink,
    close: () => {
      orchestrator.stop();
      index.close();
    },
  };
}
