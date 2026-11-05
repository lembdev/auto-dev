import { execFile } from "node:child_process";
import { appendFile, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  BranchInput,
  CloneInput,
  PushInput,
  RepoRef,
  WorktreeInfo,
  WorktreeInput,
  WorktreePort,
} from "../ports/worktree.js";

const execFileAsync = promisify(execFile);

export type GitWorktreeOptions = {
  gitBinary?: string;
  // Token for HTTPS remotes. It reaches git through the environment, never through the command line.
  token?: string;
  env?: NodeJS.ProcessEnv;
};

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly cwd: string | undefined,
    readonly exitCode: number | string | undefined,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed${cwd ? ` in ${cwd}` : ""} (${exitCode ?? "signal"}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

type ExecError = NodeJS.ErrnoException & { stderr?: string; code?: number | string };

// Git on the Product clone and its worktrees, through the `git` command line.
export class GitWorktreeAdapter implements WorktreePort {
  private readonly _git: string;
  private readonly _env: NodeJS.ProcessEnv;

  constructor(options: GitWorktreeOptions = {}) {
    this._git = options.gitBinary ?? "git";
    this._env = { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
    if (options.token !== undefined) {
      const basic = Buffer.from(`x-access-token:${options.token}`).toString("base64");
      Object.assign(this._env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      });
    }
  }

  async isRepository(target: string): Promise<boolean> {
    try {
      // Empty `cdup` means `target` is the top of a working tree, not a directory inside one.
      return (await this._run(["rev-parse", "--show-cdup"], target)).trim() === "";
    } catch (error) {
      if (error instanceof GitError) return false;
      throw error;
    }
  }

  async clone(input: CloneInput): Promise<void> {
    await this._run(["clone", "--", input.url, input.path]);
  }

  async fetch(input: RepoRef): Promise<void> {
    await this._run(["fetch", "--prune", "origin"], input.repoPath);
  }

  async addWorktree(input: WorktreeInput): Promise<void> {
    const args =
      input.base === undefined
        ? ["worktree", "add", "--", input.path, input.branch]
        : ["worktree", "add", "-b", input.branch, "--", input.path, input.base];
    await this._run(args, input.repoPath);
    await this._excludeFromStatus(input.repoPath, input.path);
  }

  async removeWorktree(input: RepoRef & { path: string }): Promise<void> {
    await this._run(["worktree", "remove", "--force", "--", input.path], input.repoPath);
  }

  // Linked worktrees only; the clone itself is not listed. Git prints resolved paths, so they are
  // spelled the way the caller spells the clone (symlinked data directories stay comparable).
  async listWorktrees(input: RepoRef): Promise<WorktreeInfo[]> {
    const output = await this._run(["worktree", "list", "--porcelain"], input.repoPath);
    const root = path.resolve(input.repoPath);
    const realRoot = await realpath(root);
    const respell = (target: string): string =>
      target === realRoot ? root : target.startsWith(`${realRoot}${path.sep}`) ? path.join(root, target.slice(realRoot.length + 1)) : target;
    return parseWorktreeList(output)
      .map((info) => ({ ...info, path: respell(info.path) }))
      .filter((info) => info.path !== root);
  }

  async listBranches(input: RepoRef): Promise<string[]> {
    const output = await this._run(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], input.repoPath);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .sort();
  }

  async deleteBranch(input: BranchInput): Promise<void> {
    await this._run(["branch", "-D", "--", input.branch], input.repoPath);
  }

  async push(input: PushInput): Promise<void> {
    const args = ["push", "--set-upstream"];
    if (input.force) args.push("--force-with-lease");
    args.push("origin", `${input.branch}:${input.branch}`);
    await this._run(args, input.cwd);
  }

  // Worktrees live inside the clone (`claude --worktree` layout); git must not report them as untracked.
  private async _excludeFromStatus(repoPath: string, worktreePath: string): Promise<void> {
    const relative = path.relative(path.resolve(repoPath), path.resolve(path.dirname(worktreePath)));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
    const pattern = `/${relative.split(path.sep).join("/")}/`;
    const excludeFile = path.resolve(repoPath, (await this._run(["rev-parse", "--git-path", "info/exclude"], repoPath)).trim());
    let current = "";
    try {
      current = await readFile(excludeFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current.split("\n").some((line) => line.trim() === pattern)) return;
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await appendFile(excludeFile, `${separator}${pattern}\n`);
  }

  private async _run(args: string[], cwd?: string): Promise<string> {
    // A missing directory makes spawn fail with the same ENOENT as a missing git binary; tell them apart first.
    if (cwd !== undefined && !(await exists(cwd))) throw new GitError(args, cwd, "ENOENT", `no such directory: ${cwd}`);
    try {
      const { stdout } = await execFileAsync(this._git, args, {
        ...(cwd === undefined ? {} : { cwd }),
        env: this._env,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const failure = error as ExecError;
      if (failure.stderr === undefined || failure.code === "ENOENT") throw error;
      throw new GitError(args, cwd, failure.code, failure.stderr);
    }
  }
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

// Blocks of `git worktree list --porcelain`: `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>` or `detached`.
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, head: "" };
      result.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return result;
}
