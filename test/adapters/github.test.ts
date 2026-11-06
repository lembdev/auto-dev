import { describe, expect, it } from "vitest";
import { GITHUB_API_VERSION, GitHubRestAdapter, nextLink } from "../../src/adapters/github.js";
import { FakeClock } from "../../src/fakes/clock.js";
import type { CommentId, IssueNumber, PullNumber } from "../../src/ids.js";
import { GitHubError, GitHubNotFoundError } from "../../src/ports/github.js";

type Recorded = { method: string; url: URL; headers: Record<string, string>; body: unknown };
type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (request: Recorded, nth: number) => Answer;

// A fetch stand-in: records every request and answers from `handler`.
const fakeFetch = (handler: Handler) => {
  const requests: Recorded[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const recorded: Recorded = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(recorded);
    const answer = handler(recorded, requests.length);
    const status = answer.status ?? 200;
    const body = status === 204 || status === 304 || answer.body === undefined ? null : JSON.stringify(answer.body);
    return new Response(body, { status, headers: { "content-type": "application/json", ...answer.headers } });
  };
  return { fetch, requests };
};

const rawIssue = (number: number, extra: Record<string, unknown> = {}) => ({
  id: 1000 + number,
  number,
  title: `Issue ${number}`,
  body: null,
  state: "open",
  state_reason: null,
  labels: [{ name: "ready-for-agent" }],
  assignees: [],
  milestone: null,
  type: null,
  issue_dependencies_summary: { blocked_by: 0, blocking: 0, total_blocked_by: 0, total_blocking: 0 },
  sub_issues_summary: null,
  user: { login: "alice" },
  html_url: `https://github.com/acme/product/issues/${number}`,
  created_at: "2026-03-01T10:00:00Z",
  updated_at: `2026-03-01T10:00:${String(number).padStart(2, "0")}Z`,
  closed_at: null,
  ...extra,
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const setup = (handler: Handler, options: { mutationPauseMs?: number } = {}) => {
  const clock = new FakeClock(Date.parse("2026-03-01T12:00:00Z"));
  const { fetch, requests } = fakeFetch(handler);
  const github = new GitHubRestAdapter({
    token: "ghp_test",
    owner: "acme",
    repo: "product",
    clock,
    userAgent: "auto-dev/test",
    fetch,
    mutationPauseMs: options.mutationPauseMs ?? 0,
    mergePollIntervalMs: 1_000,
    mergeTimeoutMs: 5_000,
  });
  return { clock, github, requests };
};

describe("GitHubRestAdapter", () => {
  it("sends the token, the API version, the JSON accept header and a user agent on every request", async () => {
    const { github, requests } = setup(() => ({ body: { login: "auto-dev-bot" } }));
    expect(await github.getAuthenticatedUser()).toEqual({ login: "auto-dev-bot" });
    expect(requests[0]?.url.toString()).toBe("https://api.github.com/user");
    expect(requests[0]?.headers).toEqual({
      authorization: "Bearer ghp_test",
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "auto-dev/test",
    });
    expect(GITHUB_API_VERSION).toBe("2026-03-10");
  });

  it("polls issues updated since the cursor with If-None-Match and maps 304 to notModified", async () => {
    const { github, requests } = setup((request) => {
      if (request.headers["if-none-match"] === '"abc"') return { status: 304 };
      return { body: [rawIssue(2), rawIssue(1)], headers: { etag: '"abc"' } };
    });

    const first = await github.pollIssues({ since: "2026-03-01T09:00:00Z" });
    expect(first).toMatchObject({ status: "ok", etag: '"abc"' });
    if (first.status !== "ok") throw new Error("unreachable");
    expect(first.items.map((issue) => issue.number)).toEqual([1, 2]);
    const url = requests[0]?.url;
    expect(url?.pathname).toBe("/repos/acme/product/issues");
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      state: "all",
      sort: "updated",
      direction: "desc",
      since: "2026-03-01T09:00:00Z",
      per_page: "100",
    });
    expect(requests[0]?.headers["if-none-match"]).toBeUndefined();

    const second = await github.pollIssues({ since: "2026-03-01T09:00:00Z", etag: '"abc"' });
    expect(second).toEqual({ status: "notModified" });
    expect(requests[1]?.headers["if-none-match"]).toBe('"abc"');
  });

  it("follows Link rel=next and keeps the ETag of the first page", async () => {
    const { github, requests } = setup((request) => {
      if (request.url.searchParams.get("page") === "2") return { body: [rawIssue(3)] };
      return {
        body: [rawIssue(2), rawIssue(1)],
        headers: {
          etag: '"page1"',
          link: '<https://api.github.com/repos/acme/product/issues?state=all&page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"',
        },
      };
    });
    const result = await github.pollIssues({});
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.items.map((issue) => issue.number)).toEqual([1, 2, 3]);
    expect(result.etag).toBe('"page1"');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers["if-none-match"]).toBeUndefined();
    expect(nextLink(null)).toBeUndefined();
  });

  it("maps issue fields: assignees, labels, type, dependencies, milestone, parent and pull requests", async () => {
    const { github } = setup(() => ({
      body: rawIssue(5, {
        body: "Do it",
        labels: ["bug", { name: "ready-for-agent" }],
        assignees: [{ login: "auto-dev-bot" }],
        milestone: { number: 3, title: "Эпик 3" },
        type: { name: "Bug" },
        issue_dependencies_summary: { blocked_by: 1, blocking: 2, total_blocked_by: 3, total_blocking: 4 },
        sub_issues_summary: { total: 2, completed: 1 },
        parent_issue_url: "https://api.github.com/repos/acme/product/issues/4",
      }),
    }));
    const issue = await github.getIssue(5 as IssueNumber);
    expect(issue).toMatchObject({
      id: 1005,
      number: 5,
      body: "Do it",
      labels: ["bug", "ready-for-agent"],
      assignees: ["auto-dev-bot"],
      milestone: { number: 3, title: "Эпик 3" },
      type: "Bug",
      isPullRequest: false,
      dependencies: { blockedBy: 1, blocking: 2, totalBlockedBy: 3, totalBlocking: 4 },
      subIssues: { total: 2, completed: 1 },
      parentIssueNumber: 4,
      author: "alice",
    });

    const asPull = setup(() => ({ body: rawIssue(6, { pull_request: { url: "x", merged_at: null }, issue_dependencies_summary: null }) }));
    const pull = await asPull.github.getIssue(6 as IssueNumber);
    expect(pull.isPullRequest).toBe(true);
    expect(pull.dependencies.blockedBy).toBe(0);
  });

  it("maps comments to their issue number", async () => {
    const { github, requests } = setup(() => ({
      body: [
        {
          id: 77,
          issue_url: "https://api.github.com/repos/acme/product/issues/12",
          body: "blue",
          user: { login: "alice" },
          html_url: "https://github.com/acme/product/issues/12#issuecomment-77",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      ],
      headers: { etag: '"c"' },
    }));
    const result = await github.pollIssueComments({ since: "2026-03-01T09:00:00Z" });
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.items).toEqual([
      {
        id: 77,
        issueNumber: 12,
        body: "blue",
        author: "alice",
        htmlUrl: "https://github.com/acme/product/issues/12#issuecomment-77",
        createdAt: "2026-03-01T10:00:00Z",
        updatedAt: "2026-03-01T10:00:00Z",
      },
    ]);
    expect(requests[0]?.url.pathname).toBe("/repos/acme/product/issues/comments");
    expect(requests[0]?.url.searchParams.get("sort")).toBe("updated");
  });

  it("runs mutating calls one at a time with a one second pause measured on the clock", async () => {
    const { clock, github, requests } = setup(
      (request) => (request.method === "GET" ? { body: rawIssue(7) } : { status: request.method === "DELETE" ? 200 : 201, body: {} }),
      { mutationPauseMs: 1_000 },
    );
    const order: string[] = [];
    const assign = github.addAssignees(7 as IssueNumber, ["auto-dev-bot"]).then(() => order.push("assign"));
    const unlabel = github.removeLabel(7 as IssueNumber, "ready-for-agent").then(() => order.push("unlabel"));

    await assign;
    // Reads are not throttled: they go out while the next mutation waits.
    await github.getIssue(7 as IssueNumber);
    await settle();
    expect(order).toEqual(["assign"]);
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "POST /repos/acme/product/issues/7/assignees",
      "GET /repos/acme/product/issues/7",
    ]);
    expect(requests[0]?.body).toEqual({ assignees: ["auto-dev-bot"] });

    await clock.advance(999);
    expect(order).toEqual(["assign"]);
    await clock.advance(1);
    await settle();
    await unlabel;
    expect(order).toEqual(["assign", "unlabel"]);
    expect(requests[2]?.url.pathname).toBe("/repos/acme/product/issues/7/labels/ready-for-agent");
  });

  it("treats a missing label on removal as success and maps other errors", async () => {
    const { github } = setup((request) => {
      if (request.url.pathname.endsWith("/labels/ready-for-agent")) return { status: 404, body: { message: "Label does not exist" } };
      if (request.url.pathname.endsWith("/issues/404")) return { status: 404, body: { message: "Not Found" } };
      return { status: 403, body: { message: "API rate limit exceeded" }, headers: { "retry-after": "30" } };
    });
    await expect(github.removeLabel(1 as IssueNumber, "ready-for-agent")).resolves.toBeUndefined();
    await expect(github.getIssue(404 as IssueNumber)).rejects.toThrow(GitHubNotFoundError);
    const error = await github.getIssue(1 as IssueNumber).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(403);
    expect((error as GitHubError).message).toBe("rate limited: retry after 30 s");
  });

  it("lists open issues with label and milestone filters and drops pull requests", async () => {
    const { github, requests } = setup(() => ({ body: [rawIssue(1), rawIssue(2, { pull_request: {} })] }));
    const issues = await github.listIssues({ state: "open", labels: ["ready-for-agent", "bug"], milestone: "none" });
    expect(issues.map((issue) => issue.number)).toEqual([1]);
    expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toEqual({
      state: "open",
      labels: "ready-for-agent,bug",
      milestone: "none",
      per_page: "100",
    });
  });

  it("patches issues and comments with GitHub field names", async () => {
    const { github, requests } = setup((request) =>
      request.url.pathname.includes("/comments/")
        ? { body: { id: 5, issue_url: "u/1", body: "x", user: null, html_url: "h", created_at: "a", updated_at: "b" } }
        : { body: rawIssue(1) },
    );
    await github.updateIssue(1 as IssueNumber, { state: "closed", stateReason: "completed", milestone: null });
    expect(requests[0]?.body).toEqual({ state: "closed", state_reason: "completed", milestone: null });
    await github.updateIssueComment(5 as CommentId, "edited");
    expect(requests[1]?.method).toBe("PATCH");
    expect(requests[1]?.url.pathname).toBe("/repos/acme/product/issues/comments/5");
    await github.addCommentReaction(5 as CommentId, "rocket");
    expect(requests[2]?.body).toEqual({ content: "rocket" });
  });

  it("merges through merge-async and polls the status until merged", async () => {
    const rawPull = {
      number: 9,
      title: "feat: x",
      body: "",
      state: "open",
      head: { ref: "worktree-issue-1", sha: "abc123" },
      base: { ref: "main" },
      merged: false,
      merged_at: null,
      mergeable: true,
      mergeable_state: "clean",
      html_url: "h",
      created_at: "a",
      updated_at: "b",
    };
    let polls = 0;
    const { clock, github, requests } = setup((request) => {
      if (request.method === "GET" && request.url.pathname === "/repos/acme/product/pulls/9") return { body: rawPull };
      if (request.method === "PUT") return { status: 202, body: { status: "pending", details: { uuid: "u-1" } } };
      polls += 1;
      return polls < 2 ? { body: { status: "pending" } } : { body: { status: "merged", details: { sha: "merged-sha" } } };
    });
    const merging = github.mergePullRequest(9 as PullNumber, { method: "squash", commitTitle: "feat: x", commitMessage: "" });
    for (let step = 0; step < 3; step += 1) {
      await settle();
      await clock.advance(1_000);
    }
    expect(await merging).toEqual({ merged: true, sha: "merged-sha" });
    expect(requests[1]?.body).toEqual({
      merge_method: "squash",
      merge_action: "direct_merge",
      commit_title: "feat: x",
      commit_message: "",
      sha: "abc123",
    });
    expect(requests.map((request) => request.url.pathname).slice(2)).toEqual([
      "/repos/acme/product/pulls/9/merge-async/u-1",
      "/repos/acme/product/pulls/9/merge-async/u-1",
    ]);
  });

  it("reports a refused merge without throwing and ignores a missing branch on delete", async () => {
    const { github } = setup((request) => {
      if (request.method === "PUT") return { status: 405, body: { message: "Pull Request is not mergeable" } };
      if (request.method === "DELETE") return { status: 422, body: { message: "Reference does not exist" } };
      return {
        body: { number: 9, title: "", body: null, state: "open", head: { ref: "b", sha: "s" }, base: { ref: "main" }, merged_at: null, html_url: "h", created_at: "a", updated_at: "b" },
      };
    });
    expect(await github.mergePullRequest(9 as PullNumber, { method: "squash", commitTitle: "t", commitMessage: "" })).toEqual({
      merged: false,
      reason: "Pull Request is not mergeable",
    });
    await expect(github.deleteBranch("worktree-issue-1")).resolves.toBeUndefined();
  });

  it("reads check runs and commit statuses of a ref", async () => {
    const { github, requests } = setup((request) =>
      request.url.pathname.endsWith("/check-runs")
        ? { body: { total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", html_url: "h", started_at: "a", completed_at: "b" }] } }
        : { body: { state: "pending", total_count: 0, statuses: [] } },
    );
    expect(await github.listCheckRuns("abc")).toEqual([
      { id: 1, name: "ci", status: "completed", conclusion: "success", htmlUrl: "h", startedAt: "a", completedAt: "b" },
    ]);
    expect(requests[0]?.url.searchParams.get("filter")).toBe("latest");
    expect(await github.listCommitStatuses("abc")).toEqual([]);
  });
  it("reads CI from GitHub Actions when the token may not read check runs, as fine-grained tokens may not", async () => {
    const { github, requests } = setup((request) => {
      if (request.url.pathname.endsWith("/check-runs")) return { status: 403, body: { message: "Resource not accessible by personal access token" } };
      return {
        body: {
          total_count: 3,
          workflow_runs: [
            { id: 3, name: "ci", workflow_id: 10, run_attempt: 2, status: "in_progress", conclusion: null, html_url: "h3", run_started_at: "c", updated_at: "d" },
            { id: 2, name: "ci", workflow_id: 10, run_attempt: 1, status: "completed", conclusion: "failure", html_url: "h2", run_started_at: "a", updated_at: "b" },
            { id: 4, name: "lint", workflow_id: 11, run_attempt: 1, status: "completed", conclusion: "success", html_url: "h4", run_started_at: "a", updated_at: "b" },
          ],
        },
      };
    });
    expect(await github.listCheckRuns("abc")).toEqual([
      { id: 3, name: "ci", status: "in_progress", conclusion: null, htmlUrl: "h3", startedAt: "c", completedAt: null },
      { id: 4, name: "lint", status: "completed", conclusion: "success", htmlUrl: "h4", startedAt: "a", completedAt: "b" },
    ]);
    expect(requests[1]?.url.pathname).toBe("/repos/acme/product/actions/runs");
    expect(requests[1]?.url.searchParams.get("head_sha")).toBe("abc");
  });

  it("names the missing permission when neither check runs nor Actions are readable", async () => {
    const { github } = setup(() => ({ status: 403, body: { message: "Resource not accessible by personal access token" } }));
    await expect(github.listCheckRuns("abc")).rejects.toThrow(/Actions: read/);
  });
});

describe("checkAccess", () => {
  const repository = { full_name: "acme/product", default_branch: "main" };

  it("reads the repository, probes the write permissions without changing anything and the reads CI needs", async () => {
    const { github, requests } = setup((request) => {
      if (request.method === "GET" && request.url.pathname.endsWith("/actions/runs")) return { body: { total_count: 0, workflow_runs: [] } };
      if (request.method === "GET" && request.url.pathname.endsWith("/status")) return { body: { state: "pending", statuses: [] } };
      if (request.method === "GET") return { body: repository };
      return { status: request.url.pathname.endsWith("/git/refs") ? 422 : 404, body: { message: "Not Found" } };
    });
    expect(await github.checkAccess()).toEqual({
      fullName: "acme/product",
      defaultBranch: "main",
      permissions: { metadataRead: true, contentsWrite: true, issuesWrite: true, pullRequestsWrite: true, actionsRead: true, statusesRead: true },
    });
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`).sort()).toEqual(
      [
        "GET /repos/acme/product",
        "GET /repos/acme/product/actions/runs",
        "GET /repos/acme/product/commits/main/status",
        "PATCH /repos/acme/product/issues/0",
        "PATCH /repos/acme/product/pulls/0",
        "POST /repos/acme/product/git/refs",
      ].sort(),
    );
  });

  it("reports the permissions the token lacks from 403 answers", async () => {
    const { github } = setup((request) => {
      if (request.url.pathname.endsWith("/actions/runs")) return { status: 403, body: { message: "Resource not accessible by personal access token" } };
      if (request.url.pathname.endsWith("/status")) return { body: { state: "pending", statuses: [] } };
      if (request.method === "GET") return { body: repository };
      if (request.url.pathname.endsWith("/pulls/0")) return { status: 403, body: { message: "Resource not accessible by personal access token" } };
      if (request.url.pathname.endsWith("/git/refs")) return { status: 403, body: { message: "Resource not accessible by personal access token" } };
      return { status: 404, body: { message: "Not Found" } };
    });
    expect((await github.checkAccess()).permissions).toEqual({
      metadataRead: true,
      contentsWrite: false,
      issuesWrite: true,
      pullRequestsWrite: false,
      actionsRead: false,
      statusesRead: true,
    });
  });

  it("reports no access at all when the repository is invisible to the token", async () => {
    const { github, requests } = setup(() => ({ status: 404, body: { message: "Not Found" } }));
    expect(await github.checkAccess()).toEqual({
      fullName: "acme/product",
      defaultBranch: null,
      permissions: { metadataRead: false, contentsWrite: false, issuesWrite: false, pullRequestsWrite: false, actionsRead: false, statusesRead: false },
    });
    expect(requests).toHaveLength(1);
  });

  it("throws on bad credentials", async () => {
    const { github } = setup(() => ({ status: 401, body: { message: "Bad credentials" } }));
    await expect(github.checkAccess()).rejects.toBeInstanceOf(GitHubError);
  });
});
