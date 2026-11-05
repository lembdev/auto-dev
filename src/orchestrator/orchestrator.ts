import path from "node:path";
import { DEFAULT_DATA_DIR } from "../config.js";
import type { CommentId, IssueNumber } from "../ids.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import { isActiveStage, type Task, type TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { TimerHandle } from "../ports/clock.js";
import { GitHubNotFoundError, type Issue, type IssueComment, type PollQuery, type PollResult } from "../ports/github.js";
import type { Ports } from "../ports/index.js";
import { Comments } from "./comments.js";
import { IntentJournal } from "./intents.js";
import { READY_LABEL, selectReadyTasks } from "./ready-tasks.js";
import { Workspace, type Product } from "./workspace.js";

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_MAX_PARALLEL_TASKS = 2;

// Keys in the `installation` table.
export const INSTALLATION_KEYS = {
  maxParallelTasks: "max_parallel_tasks",
  issuesSince: "poll.issues.since",
  issuesEtag: "poll.issues.etag",
  commentsSince: "poll.comments.since",
  commentsEtag: "poll.comments.etag",
} as const;

// Safety margin for the first `since`: the Installation clock and GitHub may disagree by a few seconds.
const FIRST_SINCE_MARGIN_MS = 60_000;

export type OrchestratorHooks = {
  // Runs once a Ready task is taken and its workspace is ready: assignee set, label removed, worktree,
  // branch and the `WIP:` pull request created, `tasks` and `transitions` written. The Implementer starts here.
  afterTake?(task: Task, issue: Issue): Promise<void>;
  // Every issue comment updated since the last poll, oldest first.
  onIssueComments?(comments: IssueComment[]): Promise<void>;
  // Every issue updated since the last poll, oldest first; runs before Ready tasks are taken.
  onIssuesUpdated?(issues: Issue[]): Promise<void>;
};

export type OrchestratorOptions = {
  ports: Ports;
  index: RuntimeIndex;
  log: Logger;
  pollIntervalMs?: number;
  hooks?: OrchestratorHooks;
  // Where the Product is cloned; defaults to `<dataDir>/repo` of a standard Installation.
  product?: Product;
};

export type Slots = { used: number; max: number };

// Polls GitHub, keeps the Ready queue and takes Ready tasks into free Slots.
export class Orchestrator {
  private readonly _ports: Ports;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _pollIntervalMs: number;
  private readonly _hooks: OrchestratorHooks;
  private readonly _intents: IntentJournal;
  private readonly _workspace: Workspace;
  private readonly _comments: Comments;
  // Last known state of every issue seen since start; polling applies updates on top.
  private readonly _issues = new Map<IssueNumber, Issue>();
  private readonly _seenComments = new Map<CommentId, string>();
  private _login: string | undefined;
  private _bootstrapped = false;
  private _running = false;
  private _timer: TimerHandle | undefined;
  private _cycle: Promise<void> | undefined;

  constructor(options: OrchestratorOptions) {
    this._ports = options.ports;
    this._index = options.index;
    this._log = options.log;
    this._pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this._hooks = options.hooks ?? {};
    this._intents = new IntentJournal({ index: this._index, log: this._log, clock: this._ports.clock });
    this._workspace = new Workspace({
      worktree: this._ports.worktree,
      github: this._ports.github,
      index: this._index,
      log: this._log,
      clock: this._ports.clock,
      journal: this._intents,
      product: options.product ?? { repoPath: path.join(DEFAULT_DATA_DIR, "repo") },
    });
    this._comments = new Comments({ github: this._ports.github, journal: this._intents });
  }

  // Journal of external actions; other parts of the pipeline register their own intent kinds here.
  get intents(): IntentJournal {
    return this._intents;
  }

  // Posts a marked comment in the issue once per `key`; safe to call again after a crash.
  postComment(issueNumber: IssueNumber, key: string, text: string): Promise<IssueComment> {
    return this._comments.post(issueNumber, key, text);
  }

  // Runs the first poll right away and keeps polling every `pollIntervalMs` until `stop()`.
  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    await this._tick();
  }

  stop(): void {
    this._running = false;
    if (this._timer !== undefined) {
      this._ports.clock.clear(this._timer);
      this._timer = undefined;
    }
  }

  get running(): boolean {
    return this._running;
  }

  // One polling cycle: issues, comments, then taking Ready tasks into free Slots. Errors propagate.
  async pollOnce(): Promise<void> {
    if (this._cycle) return this._cycle;
    this._cycle = this._poll().finally(() => {
      this._cycle = undefined;
    });
    return this._cycle;
  }

  // Ready tasks in take order, from the last poll.
  readyQueue(): Issue[] {
    const activeIssues = new Set<number>(this._index.tasks.listActive().map((task) => task.issueNumber));
    return selectReadyTasks(this._issues.values(), { login: this._login ?? "", activeIssues }).map((issue) =>
      structuredClone(issue),
    );
  }

  // Last polled state of an issue, if it has been seen since start.
  findIssue(number: IssueNumber): Issue | undefined {
    const issue = this._issues.get(number);
    return issue ? structuredClone(issue) : undefined;
  }

  slots(): Slots {
    return { used: this._index.tasks.listActive().filter(occupiesSlot).length, max: this.maxParallelTasks() };
  }

  maxParallelTasks(): number {
    const raw = this._index.installation.find(INSTALLATION_KEYS.maxParallelTasks);
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_PARALLEL_TASKS;
  }

  // Moves a Task to another Stage and records the transition. Leaving an active Stage frees its Slot.
  transition(issueNumber: IssueNumber, to: TaskStage, reason?: string): Task {
    const now = this._iso();
    return this._index.transaction(() => {
      const current = this._index.tasks.get(issueNumber);
      const task = this._index.tasks.update(issueNumber, { stage: to }, now);
      this._index.transitions.append({ issueNumber, from: current.stage, to, reason: reason ?? null, at: now });
      this._log.info({ issue: issueNumber, from: current.stage, to, reason }, "task stage changed");
      return task;
    });
  }

  // Internals

  private async _tick(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (error) {
      this._log.error({ err: error }, "polling cycle failed");
    }
    if (!this._running) return;
    this._timer = this._ports.clock.setTimeout(() => {
      this._timer = undefined;
      void this._tick();
    }, this._pollIntervalMs);
  }

  private async _poll(): Promise<void> {
    if (this._login === undefined) {
      this._login = (await this._ports.github.getAuthenticatedUser()).login;
    }
    if (!this._bootstrapped) await this._bootstrap();
    await this._recoverIntents();
    await this._pollIssues();
    await this._pollComments();
    await this._fillSlots();
  }

  // Open issues are listed once at start; after that only changes arrive through polling.
  private async _bootstrap(): Promise<void> {
    await this._workspace.ensureClone();
    const startedAt = this._ports.clock.now();
    const open = await this._ports.github.listIssues({ state: "open" });
    for (const issue of open) this._issues.set(issue.number, issue);
    const firstSince = new Date(startedAt - FIRST_SINCE_MARGIN_MS).toISOString();
    const installation = this._index.installation;
    if (installation.find(INSTALLATION_KEYS.issuesSince) === undefined) {
      installation.set(INSTALLATION_KEYS.issuesSince, firstSince);
    }
    if (installation.find(INSTALLATION_KEYS.commentsSince) === undefined) {
      installation.set(INSTALLATION_KEYS.commentsSince, firstSince);
    }
    this._bootstrapped = true;
    this._log.info({ openIssues: open.length }, "issues loaded");
  }

  // Actions interrupted by a crash or a failed call are finished here; handlers are idempotent, so
  // nothing is created twice.
  private async _recoverIntents(): Promise<void> {
    const pending = this._intents.pending().length;
    if (pending === 0) return;
    const summary = await this._intents.recover();
    this._log.info({ pending, ...summary }, "pending intents recovered");
  }

  private async _pollIssues(): Promise<void> {
    const issues = await this._pollWithCursor(INSTALLATION_KEYS.issuesSince, INSTALLATION_KEYS.issuesEtag, (query) =>
      this._ports.github.pollIssues(query),
    );
    if (issues.length === 0) return;
    for (const issue of issues) this._issues.set(issue.number, issue);
    this._log.debug({ issues: issues.map((issue) => issue.number) }, "issues updated");
    await this._hooks.onIssuesUpdated?.(issues);
  }

  // `since` is inclusive, so the newest comment of the previous poll comes back once more after the
  // cursor moves; a comment is handed over only when its update time is new.
  private async _pollComments(): Promise<void> {
    const polled = await this._pollWithCursor(
      INSTALLATION_KEYS.commentsSince,
      INSTALLATION_KEYS.commentsEtag,
      (query) => this._ports.github.pollIssueComments(query),
    );
    const fresh = polled.filter((comment) => this._seenComments.get(comment.id) !== comment.updatedAt);
    for (const comment of fresh) this._seenComments.set(comment.id, comment.updatedAt);
    if (fresh.length === 0) return;
    await this._hooks.onIssueComments?.(fresh);
  }

  // `since` and the ETag live in `installation` and move only when GitHub reports changes.
  private async _pollWithCursor<T extends { updatedAt: string }>(
    sinceKey: string,
    etagKey: string,
    poll: (query: PollQuery) => Promise<PollResult<T>>,
  ): Promise<T[]> {
    const installation = this._index.installation;
    const query: PollQuery = {};
    const since = installation.find(sinceKey);
    const etag = installation.find(etagKey);
    if (since !== undefined) query.since = since;
    if (etag !== undefined) query.etag = etag;
    const result = await poll(query);
    if (result.status === "notModified") return [];
    this._index.transaction(() => {
      if (result.etag === undefined) installation.delete(etagKey);
      else installation.set(etagKey, result.etag);
      const newest = result.items.map((item) => item.updatedAt).sort().at(-1);
      if (newest !== undefined) installation.set(sinceKey, newest);
    });
    return result.items;
  }

  private async _fillSlots(): Promise<void> {
    for (const issue of this.readyQueue()) {
      const slots = this.slots();
      if (slots.used >= slots.max) {
        this._log.debug({ ...slots, next: issue.number }, "all slots busy");
        return;
      }
      await this._take(issue);
    }
  }

  private async _take(issue: Issue): Promise<void> {
    const login = this._login ?? "";
    const github = this._ports.github;
    await github.addAssignees(issue.number, [login]);
    try {
      await github.removeLabel(issue.number, READY_LABEL);
    } catch (error) {
      // Already removed by a human in between: the issue is still ours.
      if (!(error instanceof GitHubNotFoundError)) throw error;
    }
    const now = this._iso();
    const task = this._index.transaction(() => this._recordTake(issue, now));
    const known = this._issues.get(issue.number);
    if (known) {
      known.assignees = [login];
      known.labels = known.labels.filter((label) => label !== READY_LABEL);
    }
    this._log.info({ issue: issue.number, milestone: issue.milestone?.number ?? null, attempt: task.attempt }, "task taken");
    let prepared: Task;
    try {
      prepared = await this._workspace.prepare(task, issue);
    } catch (error) {
      // The pending intent stays in the journal and is retried on the next cycle; the Task keeps its Slot.
      this._log.error({ err: error, issue: issue.number }, "workspace not ready");
      return;
    }
    try {
      await this._hooks.afterTake?.(prepared, structuredClone(issue));
    } catch (error) {
      this._log.error({ err: error, issue: issue.number }, "after-take hook failed");
    }
  }

  // A new row for a first take; a Task returned from a dead end or cancellation starts its next attempt.
  private _recordTake(issue: Issue, now: string): Task {
    const previous = this._index.tasks.find(issue.number);
    const task = previous
      ? this._index.tasks.update(
          issue.number,
          {
            title: issue.title,
            milestone: issue.milestone,
            stage: "taken",
            round: 0,
            attempt: previous.attempt + 1,
            pullNumber: null,
            branch: null,
            worktreePath: null,
            takenAt: now,
          },
          now,
        )
      : this._index.tasks.insert(
          { issueNumber: issue.number, title: issue.title, milestone: issue.milestone, stage: "taken", takenAt: now },
          now,
        );
    this._index.transitions.append({
      issueNumber: issue.number,
      from: previous?.stage ?? null,
      to: "taken",
      reason: null,
      at: now,
    });
    return task;
  }

  private _iso(): string {
    return new Date(this._ports.clock.now()).toISOString();
  }
}

// A Slot is held by every Task in an active Stage; later tickets release it while the Agent waits for a human.
const occupiesSlot = (task: Task): boolean => isActiveStage(task.stage);
