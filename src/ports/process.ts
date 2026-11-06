import type { Pid } from "../ids.js";

export type ProcessInfo = {
  pid: Pid;
  parentPid: Pid | null;
  user: string;
  command: string;
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
  // Starts a command that outlives this process (the updater): nothing is waited for, the pid comes back.
  spawnDetached(command: string, args: readonly string[]): Promise<Pid>;
}
