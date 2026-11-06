import type { Hono } from "hono";
import type { RuntimeIndex } from "../../index/runtime-index.js";
import type { LogSource } from "../../log.js";
import type { Clock } from "../../ports/clock.js";
import { computeTaskStats } from "../../stats/task-stats.js";
import type { LimitHistoryResponse, LogEntryView, LogsResponse, StatsResponse } from "../api-types.js";

export const STATS_PERIODS = [7, 30] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];
export const DEFAULT_STATS_PERIOD: StatsPeriod = 7;

export const MAX_LOG_LINES = 500;

const DAY_MS = 24 * 60 * 60_000;

export type StatsRouteDeps = {
  index: Pick<RuntimeIndex, "transitions" | "limitSamples">;
  clock: Pick<Clock, "now">;
  logs: LogSource;
};

const parsePeriod = (raw: string | undefined): StatsPeriod | undefined => {
  if (raw === undefined) return DEFAULT_STATS_PERIOD;
  const days = Number(raw);
  return (STATS_PERIODS as readonly number[]).includes(days) ? (days as StatsPeriod) : undefined;
};

// `lines` above the cap is clamped, below one or not a number is an error.
const parseLines = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return MAX_LOG_LINES;
  const lines = Number(raw);
  if (!Number.isInteger(lines) || lines < 1) return undefined;
  return Math.min(lines, MAX_LOG_LINES);
};

const PINO_LEVELS: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

// A pino JSON line becomes an entry; anything else (a crash trace, a shell line) is kept as-is.
export const parseLogLine = (raw: string): LogEntryView => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { at: null, level: null, msg: raw, raw };
    const record = parsed as Record<string, unknown>;
    const time = record.time;
    const at = typeof time === "number" ? new Date(time).toISOString() : typeof time === "string" ? time : null;
    const level = typeof record.level === "number" ? (PINO_LEVELS[record.level] ?? String(record.level)) : typeof record.level === "string" ? record.level : null;
    return { at, level, msg: typeof record.msg === "string" ? record.msg : raw, raw };
  } catch {
    return { at: null, level: null, msg: raw, raw };
  }
};

const periodError = { error: `\`days\` must be one of ${STATS_PERIODS.join(", ")}` };

// GET /api/stats, GET /api/stats/limits, GET /api/logs: the statistics page. Added to the app after its auth middleware.
export function registerStatsRoutes(app: Hono, deps: StatsRouteDeps): void {
  const sinceOf = (days: StatsPeriod): string => new Date(deps.clock.now() - days * DAY_MS).toISOString();

  app.get("/api/stats", (c) => {
    const days = parsePeriod(c.req.query("days"));
    if (days === undefined) return c.json(periodError, 400);
    const since = sinceOf(days);
    const body: StatsResponse = { days, since, ...computeTaskStats(deps.index.transitions.list(), since) };
    return c.json(body);
  });

  app.get("/api/stats/limits", (c) => {
    const days = parsePeriod(c.req.query("days"));
    if (days === undefined) return c.json(periodError, 400);
    const since = sinceOf(days);
    const body: LimitHistoryResponse = { days, since, samples: deps.index.limitSamples.list({ since }) };
    return c.json(body);
  });

  app.get("/api/logs", async (c) => {
    const lines = parseLines(c.req.query("lines"));
    if (lines === undefined) return c.json({ error: `\`lines\` must be an integer from 1 to ${MAX_LOG_LINES}` }, 400);
    const tail = await deps.logs.tail(lines);
    const body: LogsResponse = { lines, source: tail.source, entries: tail.lines.map(parseLogLine) };
    return c.json(body);
  });
}
