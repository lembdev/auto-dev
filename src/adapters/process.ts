import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { Pid } from "../ids.js";
import type { ProcessFilter, ProcessInfo, ProcessPort, RunResult } from "../ports/process.js";

const execFileAsync = promisify(execFile);
// The commands run here (systemd-run, systemctl, journalctl) answer within seconds.
const RUN_TIMEOUT_MS = 30_000;

// Reads the process table with `ps`; good enough for the Installation host (Linux, macOS for development).
export class NodeProcessPort implements ProcessPort {
  async list(filter: ProcessFilter): Promise<ProcessInfo[]> {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,user=,args="], { maxBuffer: 16 * 1024 * 1024 });
    const processes: ProcessInfo[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pid, ppid, user, command] = match;
      processes.push({
        pid: Number(pid) as Pid,
        parentPid: Number(ppid) as Pid,
        user: user ?? "",
        command: command ?? "",
      });
    }
    return processes
      .filter((info) => filter.user === undefined || info.user === filter.user)
      .filter((info) => filter.command === undefined || info.command.includes(filter.command));
  }

  async kill(pid: Pid, signal: NodeJS.Signals): Promise<boolean> {
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  async isAlive(pid: Pid): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      // EPERM means the process exists but belongs to someone else.
      return true;
    }
  }

  currentUser(): string {
    return os.userInfo().username;
  }

  isRoot(): boolean {
    return typeof process.getuid === "function" && process.getuid() === 0;
  }

  async run(command: string, args: readonly string[]): Promise<RunResult> {
    try {
      const { stdout, stderr } = await execFileAsync(command, [...args], { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      // A string code (ENOENT, EACCES) means the command never ran.
      if (typeof failed.code !== "number" && !failed.killed) throw error;
      return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr || (failed.killed ? "timed out" : "") };
    }
  }
}
