import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const isLogLevel = (value: string): value is LogLevel => (LOG_LEVELS as readonly string[]).includes(value);

// Where the UI reads the journal tail from: journald when the Installation runs under systemd, else the buffer.
export type LogTail = { source: "journal" | "buffer"; lines: string[] };

export type LogSource = {
  tail(lines: number): Promise<LogTail>;
};

export const LOG_BUFFER_CAPACITY = 500;

// The last lines the logger wrote, kept in memory so the UI can show them without journald.
export class LogBuffer implements DestinationStream, LogSource {
  private _lines: string[] = [];
  private _partial = "";

  constructor(private readonly _capacity: number = LOG_BUFFER_CAPACITY) {}

  write(chunk: string): void {
    const text = this._partial + chunk;
    const parts = text.split("\n");
    this._partial = parts.pop() ?? "";
    for (const line of parts) if (line !== "") this._lines.push(line);
    if (this._lines.length > this._capacity) this._lines = this._lines.slice(-this._capacity);
  }

  tail(lines: number): Promise<LogTail> {
    return Promise.resolve({ source: "buffer", lines: this._lines.slice(-lines) });
  }
}

export type CreateLoggerOptions = {
  level: LogLevel;
  // Defaults to stdout; tests pass their own sink.
  destination?: DestinationStream;
  // Receives the same lines as the destination.
  buffer?: LogBuffer;
};

// JSON lines, one per event, so journald keeps them as-is.
export function createLogger(options: CreateLoggerOptions): Logger {
  const destination = options.destination ?? pino.destination({ fd: 1, sync: false });
  const stream = options.buffer ? pino.multistream([{ stream: destination }, { stream: options.buffer }], { dedupe: false }) : destination;
  return pino({ level: options.level, base: { app: "auto-dev" } }, stream);
}
