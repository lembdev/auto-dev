import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, GitWorktreeAdapter, parseWorktreeList } from "../../src/adapters/worktree.js";

const execFileAsync = promisify(execFile);

// Isolated git: no user or system config, so signing, hooks and default branch settings of the machine do not leak in.
const makeEnv = (root: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

describe("GitWorktreeAdapter", () => {
  let root: string;
  let origin: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let adapter: GitWorktreeAdapter;

  const git = async (args: string[], cwd: string): Promise<string> => (await execFileAsync("git", args, { cwd, env })).stdout.trim();

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "auto-dev-git-"));
    env = makeEnv(root);
    await writeFile(path.join(root, "gitconfig"), "");
    origin = path.join(root, "origin.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", origin], { env });
    const seed = path.join(root, "seed");
    await execFileAsync("git", ["clone", "-q", origin, seed], { env });
    await writeFile(path.join(seed, "README.md"), "# product\n");
    await git(["add", "README.md"], seed);
    await git(["commit", "-q", "-m", "chore: initial commit"], seed);
    await git(["push", "-q", "origin", "main"], seed);
    repo = path.join(root, "data", "repo");
    adapter = new GitWorktreeAdapter({ env });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clones the Product, creates a worktree and branch from origin/main, pushes and cleans up", async () => {
    expect(await adapter.isRepository(repo)).toBe(false);
    await adapter.clone({ url: origin, path: repo });
    expect(await adapter.isRepository(repo)).toBe(true);
    expect(await adapter.isRepository(path.join(repo, "nested"))).toBe(false);
    await adapter.fetch({ repoPath: repo });

    const worktree = path.join(repo, ".claude", "worktrees", "issue-1");
    await adapter.addWorktree({ repoPath: repo, path: worktree, branch: "worktree-issue-1", base: "origin/main" });
    const mainSha = await git(["rev-parse", "main"], repo);
    expect(await adapter.listWorktrees({ repoPath: repo })).toEqual([{ path: worktree, branch: "worktree-issue-1", head: mainSha }]);
    expect(await adapter.listBranches({ repoPath: repo })).toEqual(["main", "worktree-issue-1"]);
    expect(await adapter.isRepository(worktree)).toBe(true);

    // The worktree directory is excluded from status, and only once.
    expect(await git(["status", "--porcelain"], repo)).toBe("");
    await expect(adapter.addWorktree({ repoPath: repo, path: worktree, branch: "worktree-issue-1", base: "origin/main" })).rejects.toThrow(GitError);
    const exclude = await readFile(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "/.claude/worktrees/")).toHaveLength(1);

    await adapter.push({ cwd: worktree, branch: "worktree-issue-1" });
    expect(await git(["branch", "--list", "worktree-issue-1"], origin)).toContain("worktree-issue-1");
    await writeFile(path.join(worktree, "feature.txt"), "done\n");
    await git(["add", "feature.txt"], worktree);
    await git(["commit", "-q", "-m", "feat: add feature"], worktree);
    await adapter.push({ cwd: worktree, branch: "worktree-issue-1" });
    const pushedSha = await git(["rev-parse", "worktree-issue-1"], origin);
    expect(pushedSha).toBe(await git(["rev-parse", "HEAD"], worktree));
    // Pushing again with nothing new is a no-op, not an error.
    await adapter.push({ cwd: worktree, branch: "worktree-issue-1" });

    await adapter.removeWorktree({ repoPath: repo, path: worktree });
    expect(await adapter.listWorktrees({ repoPath: repo })).toEqual([]);
    // An existing branch gets a worktree without a base.
    await adapter.addWorktree({ repoPath: repo, path: worktree, branch: "worktree-issue-1" });
    expect((await adapter.listWorktrees({ repoPath: repo })).map((info) => info.head)).toEqual([pushedSha]);
    await expect(adapter.deleteBranch({ repoPath: repo, branch: "worktree-issue-1" })).rejects.toThrow(GitError);
    await adapter.removeWorktree({ repoPath: repo, path: worktree });
    await adapter.deleteBranch({ repoPath: repo, branch: "worktree-issue-1" });
    expect(await adapter.listBranches({ repoPath: repo })).toEqual(["main"]);
  });

  it("reports git failures with the command and stderr", async () => {
    await expect(adapter.fetch({ repoPath: path.join(root, "nowhere") })).rejects.toThrow(/git fetch --prune origin failed/);
    await adapter.clone({ url: origin, path: repo });
    await expect(adapter.deleteBranch({ repoPath: repo, branch: "missing" })).rejects.toThrow(/not found/);
  });

  it("parses the porcelain worktree listing", () => {
    const output = [
      "worktree /data/repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /data/repo/.claude/worktrees/issue-1",
      "HEAD bbbb",
      "branch refs/heads/worktree-issue-1",
      "",
      "worktree /data/repo/.claude/worktrees/loose",
      "HEAD cccc",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/data/repo", branch: "main", head: "aaaa" },
      { path: "/data/repo/.claude/worktrees/issue-1", branch: "worktree-issue-1", head: "bbbb" },
      { path: "/data/repo/.claude/worktrees/loose", branch: null, head: "cccc" },
    ]);
  });
});
