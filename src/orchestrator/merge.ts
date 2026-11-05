import type { AgentRunner } from "../agents/agent-runner.js";
import type { IssueNumber, PullNumber, SessionId } from "../ids.js";
import type { Intent } from "../index/intents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task, TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock, TimerHandle } from "../ports/clock.js";
import type { CheckRun, CheckRunConclusion, CommitStatus, GitHubPort, IssueComment, PullRequest } from "../ports/github.js";
import type { WorkspaceCleanup } from "./cleanup.js";
import type { DeadEnds } from "./dead-end.js";
import type { Implementation } from "./implementation.js";
import { defineIntent, type IntentJournal } from "./intents.js";
import { stopAgentsOf } from "./stop-agents.js";

// How often the head of the pull request is checked while its checks run or GitHub computes mergeability.
export const CHECKS_POLL_MS = 30_000;
export const MERGEABLE_POLL_MS = 5_000;
// Checks still running this long on the same head are treated as hung.
export const CHECKS_TIMEOUT_MS = 60 * 60_000;

export type ChecksVerdict = { state: "none" } | { state: "pending" } | { state: "green" } | { state: "red"; failed: string[] };

const RED_CONCLUSIONS: ReadonlySet<CheckRunConclusion> = new Set<CheckRunConclusion>(["failure", "timed_out", "cancelled", "action_required"]);

// No checks at all means nothing to wait for; otherwise every run must complete and every status settle
// before the outcome is judged, so a red verdict always names every failure.
export const evaluateChecks = (runs: CheckRun[], statuses: CommitStatus[]): ChecksVerdict => {
  if (runs.length === 0 && statuses.length === 0) return { state: "none" };
  if (runs.some((run) => run.status !== "completed") || statuses.some((status) => status.state === "pending")) {
    return { state: "pending" };
  }
  const failed = [
    ...runs.filter((run) => RED_CONCLUSIONS.has(run.conclusion)).map((run) => run.name),
    ...statuses.filter((status) => status.state === "failure" || status.state === "error").map((status) => status.context),
  ];
  return failed.length > 0 ? { state: "red", failed } : { state: "green" };
};

export const stripWip = (title: string): string => title.replace(/^WIP:\s*/i, "");

// Why a pull request could not be merged. `reason` is the short transition reason, `text` the explanation
// for the human. The kind lets the conflict and CI handling route each case to a Merger or a QA round.
export type MergeFailureKind = "conflict" | "red-checks" | "checks-timeout" | "merge-failed";
export type MergeFailure = { reason: string; text: string; sha: string } & (
  | { kind: "conflict" }
  | { kind: "red-checks"; failed: string[] }
  | { kind: "checks-timeout" }
  | { kind: "merge-failed" }
);

export type UnmarkWipPayload = { pullNumber: PullNumber; title: string };
export type MergePullPayload = { pullNumber: PullNumber; commitTitle: string };
export type MergePullResult = { merged: true; sha: string | null } | { merged: false; reason: string };
export type DeleteRemoteBranchPayload = { pullNumber: PullNumber; branch: string };
export type CloseIssuePayload = { pullNumber: PullNumber };

export const UNMARK_WIP = defineIntent<UnmarkWipPayload>("unmark-wip");
// Squash merge with the pull request title as the whole message. A pull request already merged (by a
// recovered intent or by a human) counts as merged with an unknown commit.
export const MERGE_PULL = defineIntent<MergePullPayload, MergePullResult>("merge-pull");
export const DELETE_REMOTE_BRANCH = defineIntent<DeleteRemoteBranchPayload>("delete-remote-branch");
export const CLOSE_ISSUE = defineIntent<CloseIssuePayload>("close-issue");

export type MergeStageOptions = {
  github: GitHubPort;
  index: RuntimeIndex;
  log: Logger;
  clock: Clock;
  journal: IntentJournal;
  runner: AgentRunner;
  implementation: Implementation;
  cleanup: WorkspaceCleanup;
  deadEnds: DeadEnds;
  transition: (issueNumber: IssueNumber, to: TaskStage, reason?: string) => Task;
  postComment: (issueNumber: IssueNumber, key: string, text: string) => Promise<IssueComment>;
  baseBranch: string;
  checksPollMs?: number;
  mergeablePollMs?: number;
  checksTimeoutMs?: number;
  // Returns true when it moved the Task on itself (a Merger for a conflict, a QA round for red checks);
  // otherwise the failure is a dead end.
  onFailure?: (task: Task, failure: MergeFailure) => Promise<boolean>;
  // True while an Agent (the Merger) works on the Task: the Stage leaves the pull request alone.
  isHeld?: (task: Task) => boolean;
};

// A pull request whose head is being watched: checks running or mergeability not computed yet.
type Wait = { sha: string; since: number; timer: TimerHandle | undefined };

// The Merge Stage, run by the Orchestrator without an Agent: the `WIP:` prefix comes off, the checks of
// the head finish, the pull request is squash-merged, the remote branch deleted, the issue closed and
// commented, then the Agents are stopped, the worktree and the local branch removed and the Task is done.
// Every external step is an intent and skips what an earlier run already did, so a restart in the
// middle finishes the merge without repeating anything.
export class MergeStage {
  private readonly _github: GitHubPort;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _clock: Clock;
  private readonly _journal: IntentJournal;
  private readonly _runner: AgentRunner;
  private readonly _implementation: Implementation;
  private readonly _cleanup: WorkspaceCleanup;
  private readonly _deadEnds: DeadEnds;
  private readonly _transition: MergeStageOptions["transition"];
  private readonly _postComment: MergeStageOptions["postComment"];
  private readonly _baseBranch: string;
  private readonly _checksPollMs: number;
  private readonly _mergeablePollMs: number;
  private readonly _checksTimeoutMs: number;
  private readonly _onFailure: MergeStageOptions["onFailure"];
  private readonly _isHeld: MergeStageOptions["isHeld"];
  private readonly _waits = new Map<IssueNumber, Wait>();
  private readonly _inFlight = new Set<IssueNumber>();

  constructor(options: MergeStageOptions) {
    this._github = options.github;
    this._index = options.index;
    this._log = options.log;
    this._clock = options.clock;
    this._journal = options.journal;
    this._runner = options.runner;
    this._implementation = options.implementation;
    this._cleanup = options.cleanup;
    this._deadEnds = options.deadEnds;
    this._transition = options.transition;
    this._postComment = options.postComment;
    this._baseBranch = options.baseBranch;
    this._checksPollMs = options.checksPollMs ?? CHECKS_POLL_MS;
    this._mergeablePollMs = options.mergeablePollMs ?? MERGEABLE_POLL_MS;
    this._checksTimeoutMs = options.checksTimeoutMs ?? CHECKS_TIMEOUT_MS;
    this._onFailure = options.onFailure;
    this._isHeld = options.isHeld;
    this._journal.handle(UNMARK_WIP, (payload) => this._unmarkWip(payload));
    this._journal.handle(MERGE_PULL, (payload) => this._mergePull(payload));
    this._journal.handle(DELETE_REMOTE_BRANCH, (payload) => this._github.deleteBranch(payload.branch));
    this._journal.handle(CLOSE_ISSUE, (_payload, intent) => this._closeIssue(intent.issueNumber));
  }

  // Moves every Task in `merge` on: right after the approval, after a restart or after a failed attempt.
  async startMerges(): Promise<void> {
    for (const task of this._index.tasks.listByStage(["merge"])) {
      await this.ensure(task.issueNumber);
    }
  }

  // Runs the merge of the Task unless it is already running or its head is being watched by a timer.
  async ensure(issueNumber: IssueNumber): Promise<void> {
    const task = this._index.tasks.find(issueNumber);
    if (!task || task.stage !== "merge") {
      this._forget(issueNumber);
      return;
    }
    if (this._inFlight.has(issueNumber) || this._waits.get(issueNumber)?.timer !== undefined) return;
    if (this._isHeld?.(task)) return;
    this._inFlight.add(issueNumber);
    try {
      await this._run(task);
    } catch (error) {
      // A pending intent, if any, is finished by the journal on the next cycle; the Task stays in `merge`.
      this._log.error({ err: error, issue: issueNumber }, "merge not finished");
    } finally {
      this._inFlight.delete(issueNumber);
    }
  }

  // Whether the head of the pull request is being watched for its checks or mergeability.
  isWaiting(issueNumber: IssueNumber): boolean {
    return this._waits.has(issueNumber);
  }

  // Cancels the watch timers; the next start picks every Task in `merge` up again.
  stop(): void {
    for (const wait of this._waits.values()) {
      if (wait.timer !== undefined) this._clock.clear(wait.timer);
      wait.timer = undefined;
    }
  }

  private async _run(task: Task): Promise<void> {
    if (task.pullNumber === null) {
      this._log.warn({ issue: task.issueNumber }, "task in merge without a pull request");
      return;
    }
    const pullNumber = task.pullNumber;
    const done = this._doneSteps(task);
    const pull = await this._github.getPullRequest(pullNumber);
    const title = stripWip(pull.title);
    let sha: string | null = null;
    if (pull.merged) {
      const recorded = done.get(MERGE_PULL.name)?.result as MergePullResult | undefined;
      sha = recorded?.merged ? recorded.sha : null;
    } else {
      if (!done.has(UNMARK_WIP.name) && title !== pull.title) {
        await this._journal.run(UNMARK_WIP, task.issueNumber, { pullNumber, title });
      }
      const checks = evaluateChecks(await this._github.listCheckRuns(pull.head.sha), await this._github.listCommitStatuses(pull.head.sha));
      if (checks.state === "pending") return this._wait(task, pull, this._checksPollMs);
      if (checks.state === "red") {
        const failed = checks.failed.join(", ");
        return this._fail(task, {
          kind: "red-checks",
          reason: `merge: red checks: ${failed}`,
          text: `PR #${pullNumber} не слит: красные проверки CI (${failed}).`,
          sha: pull.head.sha,
          failed: checks.failed,
        });
      }
      if (pull.mergeable === null) return this._wait(task, pull, this._mergeablePollMs);
      if (pull.mergeable === false) {
        return this._fail(task, {
          kind: "conflict",
          reason: `merge: conflict with ${this._baseBranch}`,
          text: `PR #${pullNumber} не слит: конфликт с \`${this._baseBranch}\` (${pull.mergeableState}).`,
          sha: pull.head.sha,
        });
      }
      this._forget(task.issueNumber);
      const result = done.has(MERGE_PULL.name)
        ? (done.get(MERGE_PULL.name)?.result as MergePullResult)
        : await this._journal.run(MERGE_PULL, task.issueNumber, { pullNumber, commitTitle: title });
      if (!result.merged) {
        return this._fail(task, {
          kind: "merge-failed",
          reason: `merge failed: ${result.reason}`,
          text: `PR #${pullNumber} не слит, GitHub ответил: ${result.reason}`,
          sha: pull.head.sha,
        });
      }
      sha = result.sha;
      this._log.info({ issue: task.issueNumber, pull: pullNumber, sha }, "pull request merged");
    }
    this._forget(task.issueNumber);
    // The branch is null once the cleanup ran; a crash right after it lands here with the step done.
    if (task.branch !== null && !done.has(DELETE_REMOTE_BRANCH.name)) {
      await this._journal.run(DELETE_REMOTE_BRANCH, task.issueNumber, { pullNumber, branch: task.branch });
    }
    if (!done.has(CLOSE_ISSUE.name)) await this._journal.run(CLOSE_ISSUE, task.issueNumber, { pullNumber });
    const session = this._implementation.findImplementer(task)?.sessionId ?? null;
    await this._postComment(task.issueNumber, `done:${task.attempt}`, finalComment(pull, title, sha, session, this._baseBranch));
    await stopAgentsOf(this._runner, this._index.agents, task.issueNumber);
    // The remote branch went right after the merge; the cleanup removes the worktree and the local branch.
    await this._cleanup.run(task, { remoteBranch: false });
    this._transition(task.issueNumber, "done", "pull request merged");
    this._log.info({ issue: task.issueNumber, pull: pullNumber }, "task done");
  }

  // Watches the head: the next look comes through the clock; the same head hanging too long is a failure.
  private async _wait(task: Task, pull: PullRequest, intervalMs: number): Promise<void> {
    const now = this._clock.now();
    let wait = this._waits.get(task.issueNumber);
    if (!wait || wait.sha !== pull.head.sha) {
      wait = { sha: pull.head.sha, since: now, timer: undefined };
      this._waits.set(task.issueNumber, wait);
    }
    const waitedMs = now - wait.since;
    if (waitedMs >= this._checksTimeoutMs) {
      const minutes = Math.round(waitedMs / 60_000);
      return this._fail(task, {
        kind: "checks-timeout",
        reason: `merge: checks not finished in ${minutes} min`,
        text: `PR #${pull.number} не слит: проверки CI не завершились за ${minutes} мин на коммите \`${pull.head.sha}\`.`,
        sha: pull.head.sha,
      });
    }
    const watched = wait;
    watched.timer = this._clock.setTimeout(() => {
      watched.timer = undefined;
      this.ensure(task.issueNumber).catch((error: unknown) => this._log.error({ err: error, issue: task.issueNumber }, "merge check failed"));
    }, intervalMs);
    this._log.debug({ issue: task.issueNumber, pull: pull.number, sha: pull.head.sha, waitedMs }, "waiting for the head of the pull request");
  }

  private async _fail(task: Task, failure: MergeFailure): Promise<void> {
    this._forget(task.issueNumber);
    this._log.warn({ issue: task.issueNumber, kind: failure.kind, reason: failure.reason }, "pull request not merged");
    if (this._onFailure && (await this._onFailure(task, failure))) return;
    await this._deadEnds.enter(task.issueNumber, failure.reason, failure.text);
  }

  private _forget(issueNumber: IssueNumber): void {
    const wait = this._waits.get(issueNumber);
    if (!wait) return;
    if (wait.timer !== undefined) this._clock.clear(wait.timer);
    this._waits.delete(issueNumber);
  }

  // Steps of this attempt already finished, by kind; the pull request number ties an intent to the attempt.
  private _doneSteps(task: Task): Map<string, Intent> {
    const done = new Map<string, Intent>();
    for (const intent of this._index.intents.listFor(task.issueNumber)) {
      if (intent.state !== "done") continue;
      // A merge that failed is tried again on the next pass; only a merged one is a finished step.
      if (intent.kind === MERGE_PULL.name && !(intent.result as MergePullResult).merged) continue;
      const payload = intent.payload as { pullNumber?: number } | null;
      if (payload?.pullNumber !== task.pullNumber) continue;
      done.set(intent.kind, intent);
    }
    return done;
  }

  private async _unmarkWip(payload: UnmarkWipPayload): Promise<void> {
    await this._github.updatePullRequest(payload.pullNumber, { title: payload.title });
  }

  private async _mergePull(payload: MergePullPayload): Promise<MergePullResult> {
    const pull = await this._github.getPullRequest(payload.pullNumber);
    if (pull.merged) return { merged: true, sha: null };
    const result = await this._github.mergePullRequest(payload.pullNumber, {
      method: "squash",
      commitTitle: payload.commitTitle,
      commitMessage: "",
    });
    return result.merged ? { merged: true, sha: result.sha } : { merged: false, reason: result.reason };
  }

  private async _closeIssue(issueNumber: IssueNumber): Promise<void> {
    await this._github.updateIssue(issueNumber, { state: "closed", stateReason: "completed" });
  }
}

const finalComment = (pull: PullRequest, title: string, sha: string | null, session: SessionId | null, baseBranch: string): string => {
  const commit = sha === null ? "" : ` squash-коммитом \`${sha}\``;
  const lines = [
    `Готово: PR #${pull.number} «${title}» (${pull.htmlUrl}) влит в \`${baseBranch}\`${commit}.`,
    `Сессия Реализатора: ${session === null ? "нет данных" : `\`${session}\``}.`,
    "Worktree и локальная ветка удалены.",
  ];
  return lines.join("\n");
};
