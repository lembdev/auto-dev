import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../agents/agent-runner.js";
import type { AgentId, IssueNumber, Pid } from "../ids.js";
import type { AgentPatch, AgentRecord } from "../index/agents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import { ACTIVE_STAGES, isActiveStage, type Task, type TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock, TimerHandle } from "../ports/clock.js";
import type { AskHumanCall } from "../ports/driver.js";
import { GitHubNotFoundError, type GitHubPort, type Issue } from "../ports/github.js";
import type { ProcessInfo, ProcessPort } from "../ports/process.js";
import type { DeadEnds } from "./dead-end.js";
import type { AskHumanHandler } from "./implementation.js";
import { isUsageLimitError } from "./installation-state.js";
import type { Reconciler } from "./reconcile.js";
import { CONTINUE_PROMPT, isResult } from "./turns.js";

// SIGTERM leaves the Turn unfinished for `resume`; a process that ignores it gets SIGKILL after this pause.
export const ORPHAN_GRACE_MS = 10_000;
export const FOREIGN_SWEEP_INTERVAL_MS = 60 * 60_000;
// Substring of the command line that marks a Claude Code process.
export const CLAUDE_COMMAND = "claude";
// Only under the system user of the Installation are all other `claude` processes foreign.
export const INSTALLATION_USER = "auto-dev";
export const MAX_RESUME_FAILURES = 3;
export const HANG_TIMEOUT_MS = 30 * 60_000;
export const MAX_HANGS = 2;
export { CONTINUE_PROMPT };
export const MERGED_WHILE_DOWN_REASON = "pull request merged while down";

// Keys in the `installation` table owned by this module.
export const RECOVERY_KEYS = {
  // Agents whose Turn was cut short by a restart and is resumed as soon as new Turns may start.
  pendingResumes: "restart.resume",
  // Consecutive failed resumes per Agent; a success clears the entry.
  resumeFailures: "restart.resume_failures",
} as const;

export const resumeFailedReason = (failures: number): string => `agent resume failed ${failures} times in a row`;
export const hungReason = (hangs: number): string => `agent hung ${hangs} times in a row`;

export type RecoveryOptions = {
  github: GitHubPort;
  processes: ProcessPort;
  clock: Clock;
  runner: AgentRunner;
  index: RuntimeIndex;
  log: Logger;
  reconciler: Reconciler;
  deadEnds: DeadEnds;
  transition: (issueNumber: IssueNumber, to: TaskStage, reason?: string) => Task;
  // False while the Installation is paused or at the limit: interrupted Turns wait for the next cycle.
  canStartTurn: () => boolean;
  onAskHuman?: AskHumanHandler;
  // The Orchestrator keeps the issues it fetched here so the Ready queue sees the restored state.
  rememberIssue?: (issue: Issue) => void;
  // The Orchestrator process itself: its descendants are never foreign.
  selfPid?: Pid;
  installationUser?: string;
};

type Target = { pid: Pid; agent?: AgentId };

// Makes a restart of the Orchestrator safe: orphaned and foreign `claude` processes are terminated, the
// index is checked against GitHub, Turns cut short are resumed in their Sessions, and Agents that stop
// responding are nudged once and then handed to the human.
export class Recovery {
  private readonly _github: GitHubPort;
  private readonly _processes: ProcessPort;
  private readonly _clock: Clock;
  private readonly _runner: AgentRunner;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _reconciler: Reconciler;
  private readonly _deadEnds: DeadEnds;
  private readonly _transition: RecoveryOptions["transition"];
  private readonly _canStartTurn: () => boolean;
  private readonly _onAskHuman: AskHumanHandler | undefined;
  private readonly _rememberIssue: ((issue: Issue) => void) | undefined;
  private readonly _selfPid: Pid;
  private readonly _installationUser: string;
  // Time of the last message from each live Agent; a Turn without one for too long is a hang.
  private readonly _lastEvent = new Map<AgentId, number>();
  private readonly _hangs = new Map<AgentId, number>();
  // Resumed Agents whose process has not produced a message yet.
  private readonly _resuming = new Set<AgentId>();
  private _started = false;
  private _sweepTimer: TimerHandle | undefined;
  private _sweeping = false;

  constructor(options: RecoveryOptions) {
    this._github = options.github;
    this._processes = options.processes;
    this._clock = options.clock;
    this._runner = options.runner;
    this._index = options.index;
    this._log = options.log;
    this._reconciler = options.reconciler;
    this._deadEnds = options.deadEnds;
    this._transition = options.transition;
    this._canStartTurn = options.canStartTurn;
    this._onAskHuman = options.onAskHuman;
    this._rememberIssue = options.rememberIssue;
    this._selfPid = options.selfPid ?? (process.pid as Pid);
    this._installationUser = options.installationUser ?? INSTALLATION_USER;
    this._runner.onMessage((agent, message) => this._observe(agent, message));
    this._runner.onStateChange((agent) => this._observeState(agent));
  }

  // Once per process start: orphans and foreign processes, then the index against GitHub.
  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    await this._reapAtStart();
    this._sweepTimer = this._clock.setInterval(() => {
      this._sweepForeign().catch((error: unknown) => this._log.error({ err: error }, "foreign process sweep failed"));
    }, FOREIGN_SWEEP_INTERVAL_MS);
    await this._syncWithGitHub();
  }

  stop(): void {
    if (this._sweepTimer === undefined) return;
    this._clock.clear(this._sweepTimer);
    this._sweepTimer = undefined;
  }

  // Before the Orchestrator stops its Agents on purpose: the Turns running now continue after the restart.
  rememberRunning(): void {
    this._resuming.clear();
    for (const id of this._runner.liveIds()) {
      const agent = this._runner.find(id);
      if (agent && agent.state === "running" && this._isResumable(agent)) this._addPending(id);
    }
  }

  // A resumed Agent whose process has not produced a message yet; its failure counts as a failed resume.
  isResuming(id: AgentId): boolean {
    return this._resuming.has(id);
  }

  // Every cycle: Sessions whose Turn was cut short get a new process, once new Turns may start.
  async resumeInterrupted(): Promise<void> {
    for (const id of this._pending()) {
      const agent = this._index.agents.find(id);
      const task = agent?.issueNumber === null ? undefined : agent && this._index.tasks.find(agent.issueNumber);
      // A Task in `merge` needs no Agent any more: the merge Stage works without one.
      if (!agent || !task || !isActiveStage(task.stage) || task.stage === "merge" || agent.state === "waiting" || this._runner.isLive(id)) {
        this._removePending(id);
        continue;
      }
      if (!this._canStartTurn()) {
        this._log.debug({ agent: id, issue: task.issueNumber }, "interrupted turn not resumed: no new turns now");
        return;
      }
      await this._resume(agent, task, { resumeInterruptedTurn: true });
    }
  }

  // Every cycle: a running Agent silent for too long is interrupted and told to continue; twice in a row
  // is a dead end.
  async checkHangs(): Promise<void> {
    const now = this._clock.now();
    for (const id of this._runner.liveIds()) {
      const agent = this._index.agents.find(id);
      if (!agent || agent.issueNumber === null || agent.state !== "running") continue;
      const last = this._lastEvent.get(id);
      if (last === undefined) {
        this._lastEvent.set(id, now);
        continue;
      }
      if (now - last < HANG_TIMEOUT_MS) continue;
      const task = this._index.tasks.find(agent.issueNumber);
      if (!task || !isActiveStage(task.stage)) continue;
      await this._handleHang(agent, task, now - last);
    }
  }

  // Internals: processes

  private async _reapAtStart(): Promise<void> {
    const agents = this._index.agents.list();
    const orphans: Target[] = agents.flatMap((agent) => (agent.pid === null ? [] : [{ pid: agent.pid, agent: agent.id }]));
    const foreign = await this._listForeign(new Set(orphans.map((target) => target.pid)));
    await this._terminate([...orphans, ...foreign.map((info) => ({ pid: info.pid }))]);
    for (const agent of agents) {
      const patch: AgentPatch = {};
      if (agent.pid !== null) patch.pid = null;
      if (agent.state === "running" || agent.state === "idle") patch.state = "stopped";
      if (Object.keys(patch).length > 0) this._index.agents.update(agent.id, patch);
      if (agent.state === "running" && this._isResumable(agent)) this._addPending(agent.id);
    }
    this._log.info({ orphans: orphans.length, foreign: foreign.length, toResume: this._pending().length }, "processes reaped at start");
  }

  private async _sweepForeign(): Promise<void> {
    if (this._sweeping) return;
    this._sweeping = true;
    try {
      const own = new Set(this._index.agents.list().flatMap((agent) => (agent.pid === null ? [] : [agent.pid])));
      const foreign = await this._listForeign(own);
      if (foreign.length === 0) return;
      this._log.warn({ pids: foreign.map((info) => info.pid) }, "foreign claude processes found");
      await this._terminate(foreign.map((info) => ({ pid: info.pid })));
    } finally {
      this._sweeping = false;
    }
  }

  // `claude` processes of the Installation user that neither the index nor this process accounts for.
  // Children of known processes (MCP servers, shells of an Agent) are not foreign either.
  private async _listForeign(ownPids: ReadonlySet<Pid>): Promise<ProcessInfo[]> {
    const user = this._processes.currentUser();
    if (user !== this._installationUser) {
      this._log.debug({ user, expected: this._installationUser }, "not the installation user: foreign processes are left alone");
      return [];
    }
    const all = await this._processes.list({ user });
    const children = new Map<Pid, Pid[]>();
    for (const info of all) {
      if (info.parentPid === null) continue;
      children.set(info.parentPid, [...(children.get(info.parentPid) ?? []), info.pid]);
    }
    const ours = new Set<Pid>();
    const queue: Pid[] = [this._selfPid, ...ownPids];
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (ours.has(pid)) continue;
      ours.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return all.filter((info) => info.command.includes(CLAUDE_COMMAND) && !ours.has(info.pid));
  }

  // SIGTERM to all, one grace period, SIGKILL to the survivors.
  private async _terminate(targets: Target[]): Promise<void> {
    const delivered: Target[] = [];
    for (const target of targets) {
      if (await this._processes.kill(target.pid, "SIGTERM")) delivered.push(target);
      this._log.info({ pid: target.pid, agent: target.agent ?? null }, "process terminated");
    }
    if (delivered.length === 0) return;
    await this._clock.sleep(ORPHAN_GRACE_MS);
    for (const target of delivered) {
      if (!(await this._processes.isAlive(target.pid))) continue;
      await this._processes.kill(target.pid, "SIGKILL");
      this._log.warn({ pid: target.pid, agent: target.agent ?? null }, "process killed: it ignored SIGTERM");
    }
  }

  // Internals: GitHub

  // One issue and one pull request per Task; the Stage itself is never taken from GitHub.
  private async _syncWithGitHub(): Promise<void> {
    for (const task of this._index.tasks.listByStage([...ACTIVE_STAGES, "stuck"])) {
      try {
        await this._syncTask(task);
      } catch (error) {
        this._log.error({ err: error, issue: task.issueNumber, stage: task.stage }, "task not checked against GitHub");
      }
    }
  }

  private async _syncTask(task: Task): Promise<void> {
    let issue: Issue;
    try {
      issue = await this._github.getIssue(task.issueNumber);
    } catch (error) {
      if (!(error instanceof GitHubNotFoundError)) throw error;
      this._log.warn({ issue: task.issueNumber, stage: task.stage }, "issue of a task is gone from GitHub");
      return;
    }
    this._rememberIssue?.(issue);
    // A pull request merged by hand while down: the merge Stage finishes the Task (issue, Epic, comment, cleanup).
    if (isActiveStage(task.stage) && task.stage !== "merge" && (await this._isMerged(task))) {
      this._log.info({ issue: task.issueNumber, pull: task.pullNumber, stage: task.stage }, "pull request merged while down");
      this._transition(task.issueNumber, "merge", MERGED_WHILE_DOWN_REASON);
      return;
    }
    await this._reconciler.apply([issue]);
  }

  private async _isMerged(task: Task): Promise<boolean> {
    if (task.pullNumber === null) return false;
    try {
      return (await this._github.getPullRequest(task.pullNumber)).merged;
    } catch (error) {
      if (error instanceof GitHubNotFoundError) return false;
      throw error;
    }
  }

  // Internals: resume

  // QA rounds and conflict resolutions are disposable and restart from scratch; the Planner works with
  // the human, not alone. Only the Implementer keeps a Turn worth continuing.
  private _isResumable(agent: AgentRecord): boolean {
    return agent.issueNumber !== null && agent.role === "implementer";
  }

  private async _resume(agent: AgentRecord, task: Task, spec: { resumeInterruptedTurn?: boolean; prompt?: string }): Promise<void> {
    if (agent.sessionId === null) {
      await this._resumeFailed(agent, task, "no session id recorded");
      return;
    }
    try {
      this._runner.resume(agent.id, { ...spec, ...this._askHuman(task.issueNumber) });
    } catch (error) {
      await this._resumeFailed(agent, task, error);
      return;
    }
    this._removePending(agent.id);
    this._resuming.add(agent.id);
    this._lastEvent.set(agent.id, this._clock.now());
    this._log.info({ agent: agent.id, issue: task.issueNumber, role: agent.role, prompt: spec.prompt ?? null }, "session resumed");
  }

  private async _resumeFailed(agent: AgentRecord, task: Task, cause: unknown): Promise<void> {
    this._resuming.delete(agent.id);
    const failures = this._failuresOf(agent.id) + 1;
    this._setFailures(agent.id, failures);
    this._log.error({ err: cause, agent: agent.id, issue: task.issueNumber, failures }, "agent resume failed");
    if (failures < MAX_RESUME_FAILURES) {
      this._addPending(agent.id);
      return;
    }
    this._setFailures(agent.id, 0);
    this._removePending(agent.id);
    const detail = cause instanceof Error ? cause.message : String(cause);
    await this._deadEnds.enter(
      task.issueNumber,
      resumeFailedReason(failures),
      `Сессия Агента (${agent.role}) не возобновилась ${failures} раза подряд. Последняя ошибка: ${detail}`,
    );
  }

  private _askHuman(issueNumber: IssueNumber): { onAskHuman?: (call: AskHumanCall) => ReturnType<AskHumanHandler> } {
    const handler = this._onAskHuman;
    return handler ? { onAskHuman: (call) => handler(this._index.tasks.get(issueNumber), call) } : {};
  }

  // Internals: hangs

  private async _handleHang(agent: AgentRecord, task: Task, silentMs: number): Promise<void> {
    const hangs = (this._hangs.get(agent.id) ?? 0) + 1;
    this._hangs.set(agent.id, hangs);
    this._resuming.delete(agent.id);
    const minutes = Math.round(silentMs / 60_000);
    if (hangs >= MAX_HANGS) {
      this._hangs.delete(agent.id);
      this._lastEvent.delete(agent.id);
      await this._deadEnds.enter(
        task.issueNumber,
        hungReason(hangs),
        `Агент (${agent.role}) ${hangs} раза подряд не подавал признаков жизни ${minutes} минут, и просьба продолжить не помогла.`,
      );
      return;
    }
    this._log.warn({ agent: agent.id, issue: task.issueNumber, silentMinutes: minutes, hangs }, "agent hung: interrupting and asking it to continue");
    await this._runner.stop(agent.id);
    await this._resume(this._index.agents.get(agent.id), task, { prompt: CONTINUE_PROMPT });
  }

  // Internals: observation

  private _observe(agent: AgentRecord, message: SDKMessage): void {
    this._lastEvent.set(agent.id, this._clock.now());
    if (isResult(message)) this._hangs.delete(agent.id);
    if (!this._resuming.has(agent.id)) return;
    if (message.type === "rate_limit_event" || isUsageLimitError(message)) {
      // The limit stops the process and resumes it later; that is not a failed resume.
      this._resuming.delete(agent.id);
      return;
    }
    if (isResult(message) && message.is_error) {
      this._fail(agent, message.subtype === "success" ? message.result : message.errors.join("; "));
      return;
    }
    if (message.type === "system") return;
    this._resuming.delete(agent.id);
    this._setFailures(agent.id, 0);
    this._log.info({ agent: agent.id, issue: agent.issueNumber }, "resumed session is working");
  }

  private _observeState(agent: AgentRecord): void {
    if (agent.state === "running") this._lastEvent.set(agent.id, this._clock.now());
    if (agent.state === "stopped" && this._resuming.has(agent.id)) this._fail(agent, "process exited before its first message");
  }

  private _fail(agent: AgentRecord, cause: string): void {
    this._resuming.delete(agent.id);
    const task = agent.issueNumber === null ? undefined : this._index.tasks.find(agent.issueNumber);
    if (!task || !isActiveStage(task.stage)) return;
    this._resumeFailed(agent, task, cause).catch((error: unknown) =>
      this._log.error({ err: error, agent: agent.id, issue: task.issueNumber }, "resume failure not recorded"),
    );
  }

  // Internals: the installation table

  private _pending(): AgentId[] {
    const raw = this._index.installation.find(RECOVERY_KEYS.pendingResumes);
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((id): id is AgentId => typeof id === "number") : [];
    } catch {
      return [];
    }
  }

  private _addPending(id: AgentId): void {
    const list = this._pending();
    if (list.includes(id)) return;
    this._index.installation.set(RECOVERY_KEYS.pendingResumes, JSON.stringify([...list, id]));
  }

  private _removePending(id: AgentId): void {
    const list = this._pending();
    if (!list.includes(id)) return;
    const rest = list.filter((other) => other !== id);
    if (rest.length === 0) this._index.installation.delete(RECOVERY_KEYS.pendingResumes);
    else this._index.installation.set(RECOVERY_KEYS.pendingResumes, JSON.stringify(rest));
  }

  private _failures(): Record<string, number> {
    const raw = this._index.installation.find(RECOVERY_KEYS.resumeFailures);
    if (raw === undefined) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private _failuresOf(id: AgentId): number {
    return this._failures()[String(id)] ?? 0;
  }

  private _setFailures(id: AgentId, failures: number): void {
    const all = this._failures();
    if (failures === 0) delete all[String(id)];
    else all[String(id)] = failures;
    if (Object.keys(all).length === 0) this._index.installation.delete(RECOVERY_KEYS.resumeFailures);
    else this._index.installation.set(RECOVERY_KEYS.resumeFailures, JSON.stringify(all));
  }
}
