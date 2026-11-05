import { describe, expect, it } from "vitest";
import { FakeProcessPort } from "../../src/fakes/process.js";
import { FakeWorktreePort } from "../../src/fakes/worktree.js";
import type { Pid } from "../../src/ids.js";

describe("FakeProcessPort", () => {
  it("lists, signals and forgets processes", async () => {
    const processes = new FakeProcessPort();
    processes.spawn({ pid: 10 as Pid, command: "claude --resume abc" });
    processes.spawn({ pid: 11 as Pid, command: "claude", ignoresSigterm: true });
    processes.spawn({ pid: 12 as Pid, command: "node", user: "root" });

    expect((await processes.list({ command: "claude" })).map((info) => info.pid)).toEqual([10, 11]);
    expect((await processes.list({ user: "root" })).map((info) => info.pid)).toEqual([12]);

    expect(await processes.kill(10 as Pid, "SIGTERM")).toBe(true);
    expect(await processes.kill(11 as Pid, "SIGTERM")).toBe(true);
    expect(await processes.isAlive(10 as Pid)).toBe(false);
    expect(await processes.isAlive(11 as Pid)).toBe(true);
    expect(await processes.kill(11 as Pid, "SIGKILL")).toBe(true);
    expect(await processes.isAlive(11 as Pid)).toBe(false);
    expect(await processes.kill(99 as Pid, "SIGTERM")).toBe(false);

    expect(processes.signals).toEqual([
      { pid: 10, signal: "SIGTERM", delivered: true },
      { pid: 11, signal: "SIGTERM", delivered: true },
      { pid: 11, signal: "SIGKILL", delivered: true },
      { pid: 99, signal: "SIGTERM", delivered: false },
    ]);
    expect(processes.log.of("kill")).toHaveLength(4);
    expect(processes.currentUser()).toBe("auto-dev");
    expect(processes.isRoot()).toBe(false);
  });
});

describe("FakeWorktreePort", () => {
  it("clones, adds and removes worktrees and branches, records pushes", async () => {
    const worktree = new FakeWorktreePort();
    await worktree.clone({ url: "https://github.com/example/product.git", path: "/var/lib/auto-dev/repo" });
    const repoPath = "/var/lib/auto-dev/repo";
    const path = `${repoPath}/.claude/worktrees/issue-1`;

    await worktree.addWorktree({ repoPath, path, branch: "worktree-issue-1", base: "main" });
    expect(await worktree.listWorktrees({ repoPath })).toEqual([{ path, branch: "worktree-issue-1", head: "sha-worktree-issue-1" }]);
    expect(await worktree.listBranches({ repoPath })).toEqual(["main", "worktree-issue-1"]);
    await expect(worktree.addWorktree({ repoPath, path, branch: "x", base: "main" })).rejects.toThrow("already exists");
    await expect(worktree.addWorktree({ repoPath, path: `${path}-r2`, branch: "missing" })).rejects.toThrow("does not exist");

    await worktree.push({ cwd: path, branch: "worktree-issue-1" });
    expect(worktree.pushes).toEqual([{ cwd: path, branch: "worktree-issue-1" }]);

    await expect(worktree.deleteBranch({ repoPath, branch: "worktree-issue-1" })).rejects.toThrow("checked out");
    await worktree.removeWorktree({ repoPath, path });
    await worktree.deleteBranch({ repoPath, branch: "worktree-issue-1" });
    expect(worktree.branches(repoPath)).toEqual(["main"]);
    await expect(worktree.removeWorktree({ repoPath, path })).rejects.toThrow("does not exist");
    await expect(worktree.fetch({ repoPath: "/nowhere" })).rejects.toThrow("not a repository");

    expect(worktree.log.methods()).toEqual([
      "clone",
      "addWorktree",
      "listWorktrees",
      "listBranches",
      "addWorktree",
      "addWorktree",
      "push",
      "deleteBranch",
      "removeWorktree",
      "deleteBranch",
      "removeWorktree",
      "fetch",
    ]);
  });
});
