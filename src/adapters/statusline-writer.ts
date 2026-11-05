import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { rateLimitsFromStatusLine } from "../limits/rate-limits-file.js";

// Statusline command of an Agent process: reads the CLI's JSON from stdin and leaves the
// `rate_limits` block in the file given as the only argument. Prints nothing, never fails the CLI.
async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) return;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const limits = rateLimitsFromStatusLine(Buffer.concat(chunks).toString("utf8"), new Date());
  if (!limits) return;
  await mkdir(path.dirname(target), { recursive: true });
  // A temporary file plus rename keeps the Orchestrator from reading a half-written JSON.
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(limits), "utf8");
  await rename(temporary, target);
}

main().catch((error: unknown) => {
  process.stderr.write(`statusline-writer: ${error instanceof Error ? error.message : String(error)}\n`);
});
