import type { IssueNumber, PullNumber } from "../ids.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import { GitHubNotFoundError, type GitHubPort } from "../ports/github.js";
import type { WorktreePort } from "../ports/worktree.js";
import { defineIntent, type IntentJournal } from "./intents.js";

// What an attempt leaves behind. Every field may be null: a half-taken Task has no pull request yet,
// a Task cleaned once before has no worktree.
export type CleanupPayload = {
  pullNumber: PullNumber | null;
  branch: string | null;
  worktreePath: string | null;
};

export type CleanupResult = {
  pullClosed: boolean;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
};

// Closes the pull request (unless merged), deletes the remote branch, the worktree and the local
// branch. Each step checks what exists, so the intent may run again after a crash.
export const CLEANUP_WORKSPACE = defineIntent<CleanupPayload, CleanupResult>("cleanup-workspace");

export type CleanupDeps = {
  worktree: WorktreePort;
  github: GitHubPort;
  log: Logger;
  repoPath: string;
};

// The steps themselves, idempotent and in the only order git allows: the worktree goes before its branch.
export async function cleanupWorkspace(deps: CleanupDeps, issueNumber: IssueNumber, payload: CleanupPayload): Promise<CleanupResult> {
  const { worktree, github, log, repoPath } = deps;
  const result: CleanupResult = { pullClosed: false, worktreeRemoved: false, branchDeleted: false };
  if (payload.pullNumber !== null) {
    const pull = await findPull(github, payload.pullNumber);
    if (pull?.state === "open") {
      await github.updatePullRequest(payload.pullNumber, { state: "closed" });
      result.pullClosed = true;
      log.info({ issue: issueNumber, pull: payload.pullNumber }, "pull request closed");
    }
  }
  if (payload.branch !== null) {
    // The adapter treats a missing remote branch as deleted.
    await github.deleteBranch(payload.branch);
  }
  if (payload.worktreePath !== null) {
    const worktrees = await worktree.listWorktrees({ repoPath });
    if (worktrees.some((info) => info.path === payload.worktreePath)) {
      await worktree.removeWorktree({ repoPath, path: payload.worktreePath });
      result.worktreeRemoved = true;
      log.info({ issue: issueNumber, path: payload.worktreePath }, "worktree removed");
    }
  }
  if (payload.branch !== null) {
    const branches = await worktree.listBranches({ repoPath });
    if (branches.includes(payload.branch)) {
      await worktree.deleteBranch({ repoPath, branch: payload.branch });
      result.branchDeleted = true;
      log.info({ issue: issueNumber, branch: payload.branch }, "local branch deleted");
    }
  }
  return result;
}

const findPull = async (github: GitHubPort, pullNumber: PullNumber) => {
  try {
    return await github.getPullRequest(pullNumber);
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return undefined;
    throw error;
  }
};

export type WorkspaceCleanupOptions = CleanupDeps & {
  index: RuntimeIndex;
  clock: Clock;
  journal: IntentJournal;
};

// Removes the traces of a Task attempt through the intent journal: on cancellation, on a new attempt
// after a dead end, and after a merge.
export class WorkspaceCleanup {
  private readonly _deps: CleanupDeps;
  private readonly _index: RuntimeIndex;
  private readonly _clock: Clock;
  private readonly _journal: IntentJournal;

  constructor(options: WorkspaceCleanupOptions) {
    this._deps = { worktree: options.worktree, github: options.github, log: options.log, repoPath: options.repoPath };
    this._index = options.index;
    this._clock = options.clock;
    this._journal = options.journal;
    this._journal.handle(CLEANUP_WORKSPACE, (payload, intent) => this._perform(intent.issueNumber, payload));
  }

  // Cleans what the Task references now. A failure leaves the intent pending for the next cycle.
  async run(task: Task): Promise<CleanupResult | undefined> {
    if (task.pullNumber === null && task.branch === null && task.worktreePath === null) return undefined;
    return this._journal.run(CLEANUP_WORKSPACE, task.issueNumber, {
      pullNumber: task.pullNumber,
      branch: task.branch,
      worktreePath: task.worktreePath,
    });
  }

  // Cleanup of the previous attempt before a new one. Never throws: the new attempt uses other
  // names, and a failed cleanup is retried by the journal.
  async retire(previous: Task): Promise<void> {
    try {
      await this.run(previous);
    } catch (error) {
      this._deps.log.error({ err: error, issue: previous.issueNumber, attempt: previous.attempt }, "previous attempt not cleaned up");
    }
  }

  private async _perform(issueNumber: IssueNumber, payload: CleanupPayload): Promise<CleanupResult> {
    const result = await cleanupWorkspace(this._deps, issueNumber, payload);
    const task = this._index.tasks.find(issueNumber);
    if (task) {
      // The row stops pointing at what no longer exists, unless a newer attempt already replaced it.
      const patch = {
        ...(payload.branch !== null && task.branch === payload.branch ? { branch: null } : {}),
        ...(payload.worktreePath !== null && task.worktreePath === payload.worktreePath ? { worktreePath: null } : {}),
      };
      if (Object.keys(patch).length > 0) this._index.tasks.update(issueNumber, patch, this._iso());
    }
    return result;
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}
