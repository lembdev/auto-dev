import { Writable } from "node:stream";
import { createFakePorts, type FakePorts } from "../../src/fakes/index.js";
import { IN_MEMORY, openRuntimeIndex, type RuntimeIndex } from "../../src/index/runtime-index.js";
import { createLogger, type LogLevel, type Logger } from "../../src/log.js";
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
  log: Logger;
  sink: LogSink;
  close(): void;
};

// The server on fakes and an in-memory index: the seam every scenario test goes through.
export function createTestApp(options: { logLevel?: LogLevel; version?: string } = {}): TestApp {
  const ports = createFakePorts();
  const index = openRuntimeIndex(IN_MEMORY);
  const sink = createLogSink();
  const log = createLogger({ level: options.logLevel ?? "silent", destination: sink });
  const app = createApp({ ports, index, log, version: options.version ?? "0.0.0-test" });
  return { app, ports, index, log, sink, close: () => index.close() };
}
