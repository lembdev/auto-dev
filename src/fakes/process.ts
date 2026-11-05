import type { Pid } from "../ids.js";
import type { ProcessFilter, ProcessInfo, ProcessPort } from "../ports/process.js";
import { CallLog } from "./call-log.js";

export type FakeProcessSpec = {
  pid: Pid;
  command: string;
  user?: string;
  parentPid?: Pid | null;
  // A stubborn process survives SIGTERM and dies only from SIGKILL.
  ignoresSigterm?: boolean;
};

export type SignalRecord = {
  pid: Pid;
  signal: NodeJS.Signals;
  delivered: boolean;
};

export class FakeProcessPort implements ProcessPort {
  readonly log = new CallLog();
  readonly signals: SignalRecord[] = [];
  user = "auto-dev";
  root = false;
  private readonly _processes = new Map<Pid, FakeProcessSpec>();

  get calls() {
    return this.log.calls;
  }

  spawn(spec: FakeProcessSpec): ProcessInfo {
    this._processes.set(spec.pid, spec);
    return this._info(spec);
  }

  exit(pid: Pid): void {
    this._processes.delete(pid);
  }

  async list(filter: ProcessFilter): Promise<ProcessInfo[]> {
    this.log.record("list", filter);
    return [...this._processes.values()]
      .map((spec) => this._info(spec))
      .filter((info) => (filter.user === undefined || info.user === filter.user))
      .filter((info) => (filter.command === undefined || info.command.includes(filter.command)));
  }

  async kill(pid: Pid, signal: NodeJS.Signals): Promise<boolean> {
    this.log.record("kill", pid, signal);
    const spec = this._processes.get(pid);
    this.signals.push({ pid, signal, delivered: spec !== undefined });
    if (!spec) return false;
    const fatal = signal === "SIGKILL" || (signal === "SIGTERM" && !spec.ignoresSigterm) || signal === "SIGINT";
    if (fatal) this._processes.delete(pid);
    return true;
  }

  async isAlive(pid: Pid): Promise<boolean> {
    this.log.record("isAlive", pid);
    return this._processes.has(pid);
  }

  currentUser(): string {
    return this.user;
  }

  isRoot(): boolean {
    return this.root;
  }

  private _info(spec: FakeProcessSpec): ProcessInfo {
    return {
      pid: spec.pid,
      parentPid: spec.parentPid ?? null,
      user: spec.user ?? this.user,
      command: spec.command,
    };
  }
}
