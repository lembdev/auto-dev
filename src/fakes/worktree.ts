import type {
  BranchInput,
  CheckoutInput,
  CloneInput,
  CommitAheadInput,
  PushInput,
  RepoRef,
  WorktreeInfo,
  WorktreeInput,
  WorktreePort,
} from "../ports/worktree.js";
import { CallLog } from "./call-log.js";

type Repo = {
  url: string;
  branches: Set<string>;
  worktrees: Map<string, WorktreeInfo>;
  // Branch checked out in the clone itself.
  current: string;
  // Commits of each local branch past the base it started from.
  ahead: Map<string, number>;
};

export class FakeWorktreePort implements WorktreePort {
  readonly log = new CallLog();
  readonly pushes: PushInput[] = [];
  // Called on every push with the commits the branch carries past its base; wired to the fake GitHub.
  onPush: ((branch: string, commitsAhead: number) => void) | undefined;
  defaultBranch = "main";
  private readonly _repos = new Map<string, Repo>();

  get calls() {
    return this.log.calls;
  }

  // Pretend the Product is already cloned at `path`.
  seedRepo(path: string, url = "https://github.com/example/product.git"): void {
    this._repos.set(path, { url, branches: new Set([this.defaultBranch]), worktrees: new Map(), current: this.defaultBranch, ahead: new Map() });
  }

  currentBranch(repoPath: string): string {
    return this._repo(repoPath).current;
  }

  branches(repoPath: string): string[] {
    return [...this._repo(repoPath).branches].sort();
  }

  worktrees(repoPath: string): WorktreeInfo[] {
    return [...this._repo(repoPath).worktrees.values()];
  }

  async isRepository(path: string): Promise<boolean> {
    this.log.record("isRepository", path);
    return this._repos.has(path);
  }

  async clone(input: CloneInput): Promise<void> {
    this.log.record("clone", input);
    if (this._repos.has(input.path)) throw new Error(`destination already exists: ${input.path}`);
    this.seedRepo(input.path, input.url);
  }

  async fetch(input: RepoRef): Promise<void> {
    this.log.record("fetch", input);
    this._repo(input.repoPath);
  }

  async addWorktree(input: WorktreeInput): Promise<void> {
    this.log.record("addWorktree", input);
    const repo = this._repo(input.repoPath);
    if (repo.worktrees.has(input.path)) throw new Error(`worktree already exists: ${input.path}`);
    if (!repo.branches.has(input.branch)) {
      if (input.base === undefined) throw new Error(`branch does not exist: ${input.branch}`);
      repo.branches.add(input.branch);
      repo.ahead.set(input.branch, 0);
    }
    repo.worktrees.set(input.path, { path: input.path, branch: input.branch, head: `sha-${input.branch}` });
  }

  async removeWorktree(input: RepoRef & { path: string }): Promise<void> {
    this.log.record("removeWorktree", input);
    const repo = this._repo(input.repoPath);
    if (!repo.worktrees.delete(input.path)) throw new Error(`worktree does not exist: ${input.path}`);
  }

  async listWorktrees(input: RepoRef): Promise<WorktreeInfo[]> {
    this.log.record("listWorktrees", input);
    return this.worktrees(input.repoPath);
  }

  async listBranches(input: RepoRef): Promise<string[]> {
    this.log.record("listBranches", input);
    return this.branches(input.repoPath);
  }

  async deleteBranch(input: BranchInput): Promise<void> {
    this.log.record("deleteBranch", input);
    const repo = this._repo(input.repoPath);
    const inUse = [...repo.worktrees.values()].some((worktree) => worktree.branch === input.branch);
    if (inUse) throw new Error(`branch is checked out in a worktree: ${input.branch}`);
    if (!repo.branches.delete(input.branch)) throw new Error(`branch does not exist: ${input.branch}`);
    repo.ahead.delete(input.branch);
  }

  // Commits the branch checked out at `cwd` carries past its base.
  commitsAhead(cwd: string): number {
    const { repo, branch } = this._checkout(cwd);
    return repo.ahead.get(branch) ?? 0;
  }

  // An Agent committed in the worktree.
  agentCommit(cwd: string): void {
    const { repo, branch } = this._checkout(cwd);
    repo.ahead.set(branch, (repo.ahead.get(branch) ?? 0) + 1);
  }

  async ensureCommitAhead(input: CommitAheadInput): Promise<boolean> {
    this.log.record("ensureCommitAhead", input);
    if (this.commitsAhead(input.cwd) > 0) return false;
    this.agentCommit(input.cwd);
    return true;
  }

  async push(input: PushInput): Promise<void> {
    this.log.record("push", input);
    this.pushes.push(input);
    const checkout = this._findCheckout(input.cwd);
    this.onPush?.(input.branch, checkout ? (checkout.repo.ahead.get(input.branch) ?? 0) : 0);
  }

  async checkout(input: CheckoutInput): Promise<void> {
    this.log.record("checkout", input);
    const repo = this._repo(input.repoPath);
    if (input.base === undefined && !repo.branches.has(input.branch)) throw new Error(`branch does not exist: ${input.branch}`);
    repo.branches.add(input.branch);
    repo.current = input.branch;
  }

  private _findCheckout(cwd: string): { repo: Repo; branch: string } | undefined {
    for (const [path, repo] of this._repos) {
      if (path === cwd) return { repo, branch: repo.current };
      const branch = repo.worktrees.get(cwd)?.branch;
      if (branch) return { repo, branch };
    }
    return undefined;
  }

  private _checkout(cwd: string): { repo: Repo; branch: string } {
    const checkout = this._findCheckout(cwd);
    if (!checkout) throw new Error(`not a worktree: ${cwd}`);
    return checkout;
  }

  private _repo(path: string): Repo {
    const repo = this._repos.get(path);
    if (!repo) throw new Error(`not a repository: ${path}`);
    return repo;
  }
}
