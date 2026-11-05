import path from "node:path";

// Name of the file in the data directory where the statusline command leaves the last `rate_limits`.
export const RATE_LIMITS_FILE = "rate_limits.json";

export const rateLimitsFilePath = (dataDir: string): string => path.join(dataDir, RATE_LIMITS_FILE);

// One window of the subscription limit as the CLI reports it to a statusline command.
export type StatusLineWindow = {
  used_percentage: number;
  // Unix seconds.
  resets_at: number;
};

// What the writer stores: the two windows plus when they were seen.
export type RateLimitsFile = {
  five_hour?: StatusLineWindow;
  seven_day?: StatusLineWindow;
  updated_at: string;
};

const isWindow = (value: unknown): value is StatusLineWindow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StatusLineWindow).used_percentage === "number" &&
  typeof (value as StatusLineWindow).resets_at === "number";

const pick = (window: StatusLineWindow): StatusLineWindow => ({ used_percentage: window.used_percentage, resets_at: window.resets_at });

// Picks the `rate_limits` block out of the JSON the CLI pipes into the statusline command.
// Undefined until the first API response: the CLI renders the statusline once without it.
export function rateLimitsFromStatusLine(stdinJson: string, now: Date): RateLimitsFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const limits = (parsed as { rate_limits?: unknown }).rate_limits;
  if (typeof limits !== "object" || limits === null) return undefined;
  const windows = limits as Record<string, unknown>;
  const file: RateLimitsFile = { updated_at: now.toISOString() };
  if (isWindow(windows.five_hour)) file.five_hour = pick(windows.five_hour);
  if (isWindow(windows.seven_day)) file.seven_day = pick(windows.seven_day);
  if (!file.five_hour && !file.seven_day) return undefined;
  return file;
}

export function parseRateLimitsFile(content: string): RateLimitsFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.updated_at !== "string" || Number.isNaN(Date.parse(raw.updated_at))) return undefined;
  const file: RateLimitsFile = { updated_at: raw.updated_at };
  if (isWindow(raw.five_hour)) file.five_hour = pick(raw.five_hour);
  if (isWindow(raw.seven_day)) file.seven_day = pick(raw.seven_day);
  return file;
}
