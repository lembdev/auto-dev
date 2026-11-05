import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const isLogLevel = (value: string): value is LogLevel => (LOG_LEVELS as readonly string[]).includes(value);

export type CreateLoggerOptions = {
  level: LogLevel;
  // Defaults to stdout; tests pass their own sink.
  destination?: DestinationStream;
};

// JSON lines, one per event, so journald keeps them as-is.
export function createLogger(options: CreateLoggerOptions): Logger {
  const destination = options.destination ?? pino.destination({ fd: 1, sync: false });
  return pino({ level: options.level, base: { app: "auto-dev" } }, destination);
}
