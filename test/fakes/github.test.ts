import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/fakes/clock.js";
import { FakeGitHubPort } from "../../src/fakes/github.js";
import type { CommentId, IssueNumber, PullNumber } from "../../src/ids.js";
import { GitHubNotFoundError } from "../../src/ports/github.js";

const setup = () => {
  const clock = new FakeClock(Date.parse("2026-03-01T10:00:00Z"));
  const github = new FakeGitHubPort({ now: () => clock.now() });
  return { clock, github };
};

describe("FakeGitHubPort", () => {
  it("records every port call with its arguments", async () => {
    const { github } = setup();
    github.seedIssue({ number: 7, labels: ["ready-for-agent"] });
    await github.addAssignees(7 as IssueNumber, ["auto-dev-bot"]);
    await github.removeLabel(7 as IssueNumber, "ready-for-agent");
    expect(github.calls).toEqual([
      { method: "addAssignees", args: [7, ["auto-dev-bot"]] },
      { method: "removeLabel", args: [7, "ready-for-agent"] },
    ]);
    expect(github.issue(7)).toMatchObject({ assignees: ["auto-dev-bot"], labels: [] });
  });

  it("polls by update time with since and answers notModified on a matching ETag", async () => {
    const { clock, github } = setup();
    github.seedIssue({ number: 1 });
    await clock.advance(60_000);
    const cursor = new Date(clock.now()).toISOString();
    await clock.advance(60_000);
    github.seedIssue({ number: 2 });

    const first = await github.pollIssues({ since: cursor });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("unreachable");
    expect(first.items.map((issue) => issue.number)).toEqual([2]);

    const etag = first.etag ?? "";
    const unchanged = await github.pollIssues({ since: cursor, etag });
    expect(unchanged).toEqual({ status: "notModified" });

    await clock.advance(1_000);
    github.humanSetLabels(1, ["ready-for-agent"]);
    const changed = await github.pollIssues({ since: cursor, etag });
    expect(changed.status).toBe("ok");
    if (changed.status !== "ok") throw new Error("unreachable");
    expect(changed.items.map((issue) => issue.number)).toEqual([2, 1]);
  });

  it("keeps human comments and Orchestrator comments apart and bumps the issue on each", async () => {
    const { clock, github } = setup();
    const issue = github.seedIssue({ number: 3 });
    await clock.advance(1_000);
    const question = await github.createIssueComment(3 as IssueNumber, "<!-- auto-dev -->\nWhich colour?");
    await clock.advance(1_000);
    const answer = github.humanComment(3, "blue");
    expect(question.author).toBe("auto-dev-bot");
    expect(answer.author).toBe("alice");
    expect(github.issue(3).updatedAt > issue.updatedAt).toBe(true);

    const polled = await github.pollIssueComments({ since: question.createdAt });
    if (polled.status !== "ok") throw new Error("unreachable");
    expect(polled.items.map((comment) => comment.body)).toEqual(["<!-- auto-dev -->\nWhich colour?", "blue"]);

    await github.addCommentReaction(answer.id, "rocket");
    expect(github.reactions).toEqual([{ commentId: answer.id, content: "rocket", user: "auto-dev-bot" }]);
    await expect(github.addCommentReaction(999 as CommentId, "rocket")).rejects.toThrow(GitHubNotFoundError);
  });

  it("filters issues by state, milestone, labels and assignee", async () => {
    const { github } = setup();
    const milestone = github.seedMilestone({ number: 1, title: "Эпик 1" });
    github.seedIssue({ number: 1, milestone, labels: ["ready-for-agent"] });
    github.seedIssue({ number: 2, labels: ["ready-for-agent"], assignees: ["bob"] });
    github.seedIssue({ number: 3, milestone, state: "closed" });
    github.seedIssue({ number: 4, isPullRequest: true });

    expect((await github.listIssues({})).map((issue) => issue.number)).toEqual([1, 2]);
    expect((await github.listIssues({ milestone: 1 as never })).map((issue) => issue.number)).toEqual([1]);
    expect((await github.listIssues({ milestone: "none" })).map((issue) => issue.number)).toEqual([2]);
    expect((await github.listIssues({ state: "all", milestone: 1 as never })).map((issue) => issue.number)).toEqual([1, 3]);
    expect((await github.listIssues({ assignee: "none" })).map((issue) => issue.number)).toEqual([1]);
    expect((await github.listIssues({ labels: ["ready-for-agent"], assignee: "bob" })).map((issue) => issue.number)).toEqual([2]);
  });

  it("closes and reopens issues with a state reason", async () => {
    const { github } = setup();
    github.seedIssue({ number: 5 });
    await github.updateIssue(5 as IssueNumber, { state: "closed", stateReason: "completed" });
    expect(github.issue(5)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(github.issue(5).closedAt).not.toBeNull();
    github.humanUpdateIssue(5, { state: "open" });
    expect(github.issue(5)).toMatchObject({ state: "open", stateReason: "reopened", closedAt: null });
    await expect(github.getIssue(6 as IssueNumber)).rejects.toThrow(GitHubNotFoundError);
  });

  it("creates, updates and squash-merges pull requests", async () => {
    const { github } = setup();
    const pull = await github.createPullRequest({ title: "WIP: feat: x", body: "Closes #1", head: "worktree-issue-1", base: "main" });
    expect(pull).toMatchObject({ number: 1, state: "open", merged: false, mergeable: true, head: { ref: "worktree-issue-1" } });
    await expect(
      github.createPullRequest({ title: "dup", body: "", head: "worktree-issue-1", base: "main" }),
    ).rejects.toThrow("already exists");

    expect((await github.listPullRequests({ head: "example:worktree-issue-1" })).map((item) => item.number)).toEqual([1]);
    await github.updatePullRequest(pull.number, { title: "feat: x" });

    github.humanSetMergeable(1, false);
    expect(await github.mergePullRequest(pull.number, { method: "squash", commitTitle: "feat: x", commitMessage: "" })).toEqual({
      merged: false,
      reason: "Pull Request is not mergeable",
    });
    github.humanSetMergeable(1, true);
    expect(await github.mergePullRequest(pull.number, { method: "squash", commitTitle: "feat: x", commitMessage: "" })).toEqual({
      merged: true,
      sha: "merge-1",
    });
    expect(github.pull(1)).toMatchObject({ title: "feat: x", merged: true, state: "closed" });
    await github.deleteBranch("worktree-issue-1");
    expect(github.deletedBranches).toEqual(["worktree-issue-1"]);
    await expect(github.getPullRequest(2 as PullNumber)).rejects.toThrow(GitHubNotFoundError);
  });

  it("exposes check runs and commit statuses per ref", async () => {
    const { github } = setup();
    github.seedCheckRun("sha-1", { name: "ci", status: "in_progress" });
    github.seedCommitStatus("sha-1", { context: "lint", state: "pending" });
    expect(await github.listCheckRuns("sha-1")).toMatchObject([{ name: "ci", status: "in_progress", conclusion: null }]);
    expect(await github.listCommitStatuses("sha-1")).toMatchObject([{ context: "lint", state: "pending" }]);
    expect(await github.listCheckRuns("sha-2")).toEqual([]);
  });

  it("lists milestones and sub-issues", async () => {
    const { github } = setup();
    github.seedMilestone({ number: 2, title: "Эпик 2" });
    github.seedMilestone({ number: 1, title: "Эпик 1", state: "closed" });
    github.seedIssue({ number: 10, type: "Epic" });
    github.seedIssue({ number: 11, type: "Task", parentIssueNumber: 10 as IssueNumber });
    expect((await github.listMilestones("open")).map((item) => item.title)).toEqual(["Эпик 2"]);
    expect((await github.listMilestones("all")).map((item) => item.number)).toEqual([1, 2]);
    expect((await github.listSubIssues(10 as IssueNumber)).map((item) => item.number)).toEqual([11]);
    await github.updateMilestone(2 as never, { state: "closed" });
    expect(github.milestone(2).state).toBe("closed");
  });

  it("returns copies so callers cannot mutate the fake's state", async () => {
    const { github } = setup();
    github.seedIssue({ number: 1, labels: ["a"] });
    const copy = await github.getIssue(1 as IssueNumber);
    copy.labels.push("b");
    expect(github.issue(1).labels).toEqual(["a"]);
  });
});
