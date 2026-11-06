import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LogSource, LogTail } from "../log.js";

export type JournalExec = (command: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const systemExec: JournalExec = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
};

export type JournalLogSourceOptions = {
  unit: string;
  // Serves the tail when journalctl is missing, refuses or has nothing for the unit.
  fallback: LogSource;
  exec?: JournalExec;
};

// Reads the unit's journal with `journalctl -o cat`, which prints the raw pino lines the service wrote.
export function createJournalLogSource(options: JournalLogSourceOptions): LogSource {
  const exec = options.exec ?? systemExec;
  return {
    async tail(lines: number): Promise<LogTail> {
      try {
        const { stdout } = await exec("journalctl", ["-u", options.unit, "-n", String(lines), "-o", "cat", "--no-pager"]);
        const found = stdout.split("\n").filter((line) => line !== "");
        if (found.length > 0) return { source: "journal", lines: found };
      } catch {
        // Not under systemd, or journalctl is not allowed: the buffer is all there is.
      }
      return options.fallback.tail(lines);
    },
  };
}

export const SYSTEMD_UNIT = "auto-dev";

// systemd sets JOURNAL_STREAM for a service whose stdout goes to the journal.
export const runsUnderJournald = (env: NodeJS.ProcessEnv = process.env): boolean => env.JOURNAL_STREAM !== undefined;
