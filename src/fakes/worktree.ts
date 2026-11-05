import type {
  BranchInput,
  CloneInput,
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
};

export class FakeWorktreePort implements WorktreePort {
  readonly log = new CallLog();
  readonly pushes: PushInput[] = [];
  defaultBranch = "main";
  private readonly _repos = new Map<string, Repo>();

  get calls() {
    return this.log.calls;
  }

  // Pretend the Product is already cloned at `path`.
  seedRepo(path: string, url = "https://github.com/example/product.git"): void {
    this._repos.set(path, { url, branches: new Set([this.defaultBranch]), worktrees: new Map() });
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
  }

  async push(input: PushInput): Promise<void> {
    this.log.record("push", input);
    this.pushes.push(input);
  }

  private _repo(path: string): Repo {
    const repo = this._repos.get(path);
    if (!repo) throw new Error(`not a repository: ${path}`);
    return repo;
  }
}
