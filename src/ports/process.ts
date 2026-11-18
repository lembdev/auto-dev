import type { Pid } from "../ids.js";

export type ProcessInfo = {
  pid: Pid;
  parentPid: Pid | null;
  user: string;
  command: string;
};

// Outcome of a command run to its end; a non-zero exit is a result, not an error.
export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ProcessFilter = {
  user?: string;
  // Substring of the command line.
  command?: string;
};

// Process table of the Installation host.
export interface ProcessPort {
  list(filter: ProcessFilter): Promise<ProcessInfo[]>;
  // Resolves to false when the process does not exist.
  kill(pid: Pid, signal: NodeJS.Signals): Promise<boolean>;
  isAlive(pid: Pid): Promise<boolean>;
  currentUser(): string;
  isRoot(): boolean;
  // Runs a short command to its end. Rejects only when it cannot start at all (a missing binary).
  run(command: string, args: readonly string[]): Promise<RunResult>;
}
