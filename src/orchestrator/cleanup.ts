import type { IssueNumber } from "../ids.js";
import type { Task } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { WorktreePort } from "../ports/worktree.js";
import { defineIntent, type IntentJournal } from "./intents.js";

export type CleanupWorkspacePayload = { repoPath: string; path: string; branch: string };

// Removes the worktree and the local branch of a Task. Each step checks what exists, so finishing it
// after a crash removes nothing twice and fails on nothing already gone.
export const CLEANUP_WORKSPACE = defineIntent<CleanupWorkspacePayload>("cleanup-workspace");

export type WorkspaceCleanupOptions = {
  worktree: WorktreePort;
  journal: IntentJournal;
  log: Logger;
  repoPath: string;
};

// Local clean-up after a Task is over: after a merge and after a cancellation. A dead end keeps everything.
export class WorkspaceCleanup {
  private readonly _worktree: WorktreePort;
  private readonly _journal: IntentJournal;
  private readonly _log: Logger;
  private readonly _repoPath: string;

  constructor(options: WorkspaceCleanupOptions) {
    this._worktree = options.worktree;
    this._journal = options.journal;
    this._log = options.log;
    this._repoPath = options.repoPath;
    this._journal.handle(CLEANUP_WORKSPACE, (payload, intent) => this._remove(intent.issueNumber, payload));
  }

  // Removes the worktree and the branch recorded in the Task; a Task without them has nothing to clean.
  async remove(task: Task): Promise<void> {
    if (task.worktreePath === null || task.branch === null) return;
    await this._journal.run(CLEANUP_WORKSPACE, task.issueNumber, {
      repoPath: this._repoPath,
      path: task.worktreePath,
      branch: task.branch,
    });
  }

  private async _remove(issueNumber: IssueNumber, payload: CleanupWorkspacePayload): Promise<void> {
    const repoPath = payload.repoPath;
    const worktrees = await this._worktree.listWorktrees({ repoPath });
    if (worktrees.some((info) => info.path === payload.path)) {
      await this._worktree.removeWorktree({ repoPath, path: payload.path });
    }
    const branches = await this._worktree.listBranches({ repoPath });
    if (branches.includes(payload.branch)) {
      await this._worktree.deleteBranch({ repoPath, branch: payload.branch });
    }
    this._log.info({ issue: issueNumber, path: payload.path, branch: payload.branch }, "worktree and branch removed");
  }
}
