import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statusLineSettings, statusLineWriterArgs } from "../../src/adapters/statusline.js";
import { parseRateLimitsFile, rateLimitsFromStatusLine } from "../../src/limits/rate-limits-file.js";

// Runs the writer the way the CLI does: the statusline JSON on stdin, nothing else.
const runWriter = (args: string[], input: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });

const STATUSLINE_INPUT = {
  model: { id: "claude-sonnet-5", display_name: "Sonnet" },
  rate_limits: {
    five_hour: { used_percentage: 37, resets_at: 1767232800, extra: "ignored" },
    seven_day: { used_percentage: 12, resets_at: 1767750000 },
  },
};

describe("statusline settings", () => {
  it("builds the flag settings with the writer command pointing at the limits file of the data directory", () => {
    const settings = statusLineSettings({ dataDir: "/var/lib/auto-dev", nodePath: "/usr/bin/node", writerArgs: ["/opt/auto-dev/current/dist/adapters/statusline-writer.js"] });
    expect(settings).toEqual({
      statusLine: {
        type: "command",
        command: "'/usr/bin/node' '/opt/auto-dev/current/dist/adapters/statusline-writer.js' '/var/lib/auto-dev/rate_limits.json'",
      },
    });
  });

  it("quotes paths with spaces and quotes", () => {
    const settings = statusLineSettings({ dataDir: "/data/it's here", nodePath: "/opt/my node/node", writerArgs: ["/w.js"], refreshIntervalSec: 30 });
    expect(settings.statusLine?.command).toBe("'/opt/my node/node' '/w.js' '/data/it'\\''s here/rate_limits.json'");
    expect(settings.statusLine?.refreshInterval).toBe(30);
  });

  it("resolves the writer next to the adapter", () => {
    const args = statusLineWriterArgs();
    expect(args.at(-1)).toMatch(/statusline-writer\.(ts|js)$/);
  });
});

describe("rate limits file", () => {
  it("keeps only the two windows out of the statusline JSON", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(rateLimitsFromStatusLine(JSON.stringify(STATUSLINE_INPUT), now)).toEqual({
      five_hour: { used_percentage: 37, resets_at: 1767232800 },
      seven_day: { used_percentage: 12, resets_at: 1767750000 },
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("is undefined before the first API response and on garbage", () => {
    const now = new Date();
    expect(rateLimitsFromStatusLine(JSON.stringify({ model: { id: "x" } }), now)).toBeUndefined();
    expect(rateLimitsFromStatusLine(JSON.stringify({ rate_limits: {} }), now)).toBeUndefined();
    expect(rateLimitsFromStatusLine("{", now)).toBeUndefined();
    expect(rateLimitsFromStatusLine("null", now)).toBeUndefined();
  });

  it("reads the file back and rejects one without a timestamp", () => {
    const file = { five_hour: { used_percentage: 37, resets_at: 1767232800 }, updated_at: "2026-01-01T00:00:00.000Z" };
    expect(parseRateLimitsFile(JSON.stringify(file))).toEqual(file);
    expect(parseRateLimitsFile(JSON.stringify({ five_hour: file.five_hour }))).toBeUndefined();
    expect(parseRateLimitsFile("nope")).toBeUndefined();
  });
});

describe("statusline writer", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes the limits file atomically into the data directory and nothing else, printing nothing", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "auto-dev-statusline-"));
    const dataDir = path.join(dir, "data");
    const product = path.join(dir, "product");
    const target = path.join(dataDir, "rate_limits.json");
    const run = await runWriter([...statusLineWriterArgs(), target], JSON.stringify(STATUSLINE_INPUT), dir);
    expect(run).toEqual({ stdout: "", stderr: "", code: 0 });
    const written = parseRateLimitsFile(await readFile(target, "utf8"));
    expect(written).toMatchObject({ five_hour: { used_percentage: 37 }, seven_day: { used_percentage: 12 } });
    expect(await readdir(dataDir)).toEqual(["rate_limits.json"]);
    await expect(readdir(product)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dir)).toEqual(["data"]);
  });
});
