import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { Pid } from "../ids.js";
import type { ProcessFilter, ProcessInfo, ProcessPort } from "../ports/process.js";

const execFileAsync = promisify(execFile);

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
}
