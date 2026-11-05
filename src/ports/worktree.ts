export type CloneInput = {
  url: string;
  path: string;
};

export type WorktreeInput = {
  repoPath: string;
  path: string;
  branch: string;
  // Start point for a new branch; absent when the branch already exists.
  base?: string;
};

export type WorktreeInfo = {
  path: string;
  branch: string | null;
  head: string;
};

export type RepoRef = {
  repoPath: string;
};

export type BranchInput = RepoRef & {
  branch: string;
};

export type PushInput = {
  // Working directory of the push: a worktree or the main clone.
  cwd: string;
  branch: string;
  force?: boolean;
};

// Git operations on the Product clone and its worktrees.
export interface WorktreePort {
  // True when `path` is the root of a git working tree (the Product clone).
  isRepository(path: string): Promise<boolean>;
  clone(input: CloneInput): Promise<void>;
  fetch(input: RepoRef): Promise<void>;
  addWorktree(input: WorktreeInput): Promise<void>;
  removeWorktree(input: RepoRef & { path: string }): Promise<void>;
  listWorktrees(input: RepoRef): Promise<WorktreeInfo[]>;
  listBranches(input: RepoRef): Promise<string[]>;
  deleteBranch(input: BranchInput): Promise<void>;
  push(input: PushInput): Promise<void>;
}
