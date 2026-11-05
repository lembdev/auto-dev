import path from "node:path";
import type { IssueNumber, PullNumber } from "../ids.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { GitHubPort, Issue } from "../ports/github.js";
import type { WorktreePort } from "../ports/worktree.js";
import { AUTO_DEV_MARKER } from "./comments.js";
import { defineIntent, type IntentJournal } from "./intents.js";

export const DEFAULT_BASE_BRANCH = "main";
// Layout of `claude --worktree`: worktrees live inside the clone, under a directory git ignores.
export const WORKTREES_DIR = path.join(".claude", "worktrees");
export const WIP_PREFIX = "WIP: ";

// `issue-<N>` for the first attempt, `issue-<N>-r<k>` for a retry after a dead end.
export const worktreeName = (issueNumber: IssueNumber, attempt: number): string =>
  attempt <= 1 ? `issue-${issueNumber}` : `issue-${issueNumber}-r${attempt}`;

export const branchName = (name: string): string => `worktree-${name}`;

export const worktreePath = (repoPath: string, name: string): string => path.join(repoPath, WORKTREES_DIR, name);

export const pullRequestBody = (issueNumber: IssueNumber): string => `Closes #${issueNumber}\n\n${AUTO_DEV_MARKER}`;

export type Product = {
  // Clone of the Product: `<dataDir>/repo`.
  repoPath: string;
  // Used only when the clone is missing at start.
  cloneUrl?: string;
  baseBranch?: string;
};

// One intent covers the whole take: worktree, branch, push and pull request. Each step checks what
// already exists, so finishing a half-done intent after a crash creates nothing twice.
export type PrepareWorkspacePayload = { branch: string; path: string; base: string; title: string };
export type PrepareWorkspaceResult = { pullNumber: PullNumber };

export const PREPARE_WORKSPACE = defineIntent<PrepareWorkspacePayload, PrepareWorkspaceResult>("prepare-workspace");

export type WorkspaceOptions = {
  worktree: WorktreePort;
  github: GitHubPort;
  index: RuntimeIndex;
  log: Logger;
  clock: Clock;
  journal: IntentJournal;
  product: Product;
};

// Git side of a Task: the clone, its worktree and branch, and the `WIP:` pull request. Every external
// step goes through the intent journal, so a crash in the middle is finished on the next start.
export class Workspace {
  private readonly _worktree: WorktreePort;
  private readonly _github: GitHubPort;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _clock: Clock;
  private readonly _journal: IntentJournal;
  private readonly _product: Product;

  constructor(options: WorkspaceOptions) {
    this._worktree = options.worktree;
    this._github = options.github;
    this._index = options.index;
    this._log = options.log;
    this._clock = options.clock;
    this._journal = options.journal;
    this._product = options.product;
    this._journal.handle(PREPARE_WORKSPACE, (payload, intent) => this._prepare(intent.issueNumber, payload));
  }

  get repoPath(): string {
    return this._product.repoPath;
  }

  get baseBranch(): string {
    return this._product.baseBranch ?? DEFAULT_BASE_BRANCH;
  }

  // Clones the Product when the data directory has no clone yet.
  async ensureClone(): Promise<void> {
    if (await this._worktree.isRepository(this.repoPath)) return;
    const url = this._product.cloneUrl;
    if (url === undefined) throw new Error(`the Product is not cloned at ${this.repoPath} and no clone URL is configured`);
    this._log.info({ url, path: this.repoPath }, "cloning the Product");
    await this._worktree.clone({ url, path: this.repoPath });
  }

  // Worktree, branch, push and pull request for a freshly taken Task. Returns the Task with its new fields.
  async prepare(task: Task, issue: Issue): Promise<Task> {
    const name = worktreeName(task.issueNumber, task.attempt);
    const branch = branchName(name);
    const cwd = worktreePath(this.repoPath, name);
    await this._journal.run(PREPARE_WORKSPACE, task.issueNumber, { branch, path: cwd, base: this.baseBranch, title: issue.title });
    return this._index.tasks.get(task.issueNumber);
  }

  private async _prepare(issueNumber: IssueNumber, payload: PrepareWorkspacePayload): Promise<PrepareWorkspaceResult> {
    await this._createWorktree(issueNumber, payload);
    await this._worktree.push({ cwd: payload.path, branch: payload.branch });
    return this._openPullRequest(issueNumber, payload);
  }

  private async _createWorktree(issueNumber: IssueNumber, payload: PrepareWorkspacePayload): Promise<void> {
    const repoPath = this.repoPath;
    await this._worktree.fetch({ repoPath });
    const existing = (await this._worktree.listWorktrees({ repoPath })).find((info) => info.path === payload.path);
    if (!existing) {
      const branches = await this._worktree.listBranches({ repoPath });
      const input = branches.includes(payload.branch)
        ? { repoPath, path: payload.path, branch: payload.branch }
        : { repoPath, path: payload.path, branch: payload.branch, base: `origin/${payload.base}` };
      await this._worktree.addWorktree(input);
      this._log.info({ issue: issueNumber, branch: payload.branch, path: payload.path }, "worktree created");
    }
    this._index.tasks.update(issueNumber, { branch: payload.branch, worktreePath: payload.path }, this._iso());
  }

  private async _openPullRequest(issueNumber: IssueNumber, payload: PrepareWorkspacePayload): Promise<PrepareWorkspaceResult> {
    const open = await this._github.listPullRequests({ state: "open", head: payload.branch });
    let pull = open[0];
    if (!pull) {
      pull = await this._github.createPullRequest({
        title: `${WIP_PREFIX}${payload.title}`,
        body: pullRequestBody(issueNumber),
        head: payload.branch,
        base: payload.base,
      });
      this._log.info({ issue: issueNumber, pull: pull.number, branch: payload.branch }, "pull request opened");
    }
    this._index.tasks.update(issueNumber, { pullNumber: pull.number }, this._iso());
    return { pullNumber: pull.number };
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}
