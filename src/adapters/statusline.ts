import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rateLimitsFilePath } from "../limits/rate-limits-file.js";

// The writer next to this module: compiled JS under dist/, the TypeScript source under tsx in dev mode.
export function statusLineWriterArgs(): string[] {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  if (here.endsWith(".ts")) {
    const tsx = path.resolve(dir, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    return [tsx, path.join(dir, "statusline-writer.ts")];
  }
  return [path.join(dir, "statusline-writer.js")];
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export type StatusLineOptions = {
  dataDir: string;
  // `node` the writer runs under; the Installation's own binary by default.
  nodePath?: string;
  writerArgs?: string[];
  // Seconds between re-runs on top of event-driven refreshes.
  refreshIntervalSec?: number;
};

// Settings handed to the Agent process as its "flag settings" layer: the statusline command
// writes the subscription limits into the data directory. Nothing is written into the Product.
export function statusLineSettings(options: StatusLineOptions): Settings {
  const command = [options.nodePath ?? process.execPath, ...(options.writerArgs ?? statusLineWriterArgs()), rateLimitsFilePath(options.dataDir)]
    .map(shellQuote)
    .join(" ");
  return {
    statusLine: {
      type: "command",
      command,
      ...(options.refreshIntervalSec !== undefined ? { refreshInterval: options.refreshIntervalSec } : {}),
    },
  };
}
