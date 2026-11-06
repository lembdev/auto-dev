import type { CommentId, IssueId, IssueNumber, MilestoneNumber, PullNumber } from "../ids.js";
import type { Clock } from "../ports/clock.js";
import {
  GitHubError,
  GitHubNotFoundError,
  type CheckRun,
  type CommitStatus,
  type CreatePullRequestInput,
  type GitHubPort,
  type Issue,
  type IssueComment,
  type IssueFilter,
  type IssuePatch,
  type IssueState,
  type MergeInput,
  type MergeResult,
  type Milestone,
  type PollQuery,
  type PollResult,
  type PullRequest,
  type PullRequestFilter,
  type PullRequestPatch,
  type ReactionContent,
  type RepositoryAccess,
} from "../ports/github.js";

export const GITHUB_API_VERSION = "2026-03-10";
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const PER_PAGE = 100;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type GitHubRestOptions = {
  token: string;
  owner: string;
  repo: string;
  clock: Clock;
  // Shown in `User-Agent`; GitHub requires one.
  userAgent: string;
  fetch?: FetchLike;
  baseUrl?: string;
  // Minimum gap between two mutating requests (secondary rate limit).
  mutationPauseMs?: number;
  // Poll interval and overall budget for the asynchronous merge.
  mergePollIntervalMs?: number;
  mergeTimeoutMs?: number;
};

type Query = Record<string, string | number | undefined>;

type RequestOptions = {
  query?: Query;
  body?: unknown;
  etag?: string;
  // Statuses to hand back to the caller instead of throwing.
  allow?: number[];
};

type Reply = {
  status: number;
  headers: Headers;
  json: unknown;
};

type RawUser = { login: string };
type RawRepository = { full_name: string; default_branch: string | null };
type RawLabel = string | { name: string };
type RawMilestone = {
  number: number;
  title: string;
  state: string;
  description: string | null;
  open_issues: number;
  closed_issues: number;
  created_at: string;
  html_url: string;
};
type RawIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  labels: RawLabel[];
  assignees: RawUser[] | null;
  milestone: { number: number; title: string } | null;
  type: { name: string } | null;
  pull_request?: unknown;
  issue_dependencies_summary?: {
    blocked_by: number;
    blocking: number;
    total_blocked_by: number;
    total_blocking: number;
  } | null;
  sub_issues_summary?: { total: number; completed: number } | null;
  parent_issue_url?: string | null;
  user: RawUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};
type RawComment = {
  id: number;
  issue_url: string;
  body: string | null;
  user: RawUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
};
type RawPull = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  merged?: boolean;
  merged_at: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  html_url: string;
  created_at: string;
  updated_at: string;
};
type RawCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
};
type RawStatus = { context: string; state: string; target_url: string | null; updated_at: string };
type RawMergeAsync = {
  status?: string;
  details?: { uuid?: string; sha?: string; message?: string };
  message?: string;
};

const numberFromUrl = (url: string): number => Number(url.slice(url.lastIndexOf("/") + 1));

const toIssue = (raw: RawIssue): Issue => ({
  id: raw.id as IssueId,
  number: raw.number as IssueNumber,
  title: raw.title,
  body: raw.body ?? "",
  state: raw.state === "closed" ? "closed" : "open",
  stateReason: (raw.state_reason as Issue["stateReason"]) ?? null,
  labels: (raw.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
  assignees: (raw.assignees ?? []).map((user) => user.login),
  milestone: raw.milestone ? { number: raw.milestone.number as MilestoneNumber, title: raw.milestone.title } : null,
  type: raw.type?.name ?? null,
  isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
  dependencies: {
    blockedBy: raw.issue_dependencies_summary?.blocked_by ?? 0,
    blocking: raw.issue_dependencies_summary?.blocking ?? 0,
    totalBlockedBy: raw.issue_dependencies_summary?.total_blocked_by ?? 0,
    totalBlocking: raw.issue_dependencies_summary?.total_blocking ?? 0,
  },
  subIssues: raw.sub_issues_summary
    ? { total: raw.sub_issues_summary.total, completed: raw.sub_issues_summary.completed }
    : null,
  parentIssueNumber: raw.parent_issue_url ? (numberFromUrl(raw.parent_issue_url) as IssueNumber) : null,
  author: raw.user?.login ?? "",
  htmlUrl: raw.html_url,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  closedAt: raw.closed_at,
});

const toComment = (raw: RawComment): IssueComment => ({
  id: raw.id as CommentId,
  issueNumber: numberFromUrl(raw.issue_url) as IssueNumber,
  body: raw.body ?? "",
  author: raw.user?.login ?? "",
  htmlUrl: raw.html_url,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

const toMilestone = (raw: RawMilestone): Milestone => ({
  number: raw.number as MilestoneNumber,
  title: raw.title,
  state: raw.state === "closed" ? "closed" : "open",
  description: raw.description ?? "",
  openIssues: raw.open_issues,
  closedIssues: raw.closed_issues,
  createdAt: raw.created_at,
  htmlUrl: raw.html_url,
});

const toPull = (raw: RawPull): PullRequest => ({
  number: raw.number as PullNumber,
  title: raw.title,
  body: raw.body ?? "",
  state: raw.state === "closed" ? "closed" : "open",
  head: { ref: raw.head.ref, sha: raw.head.sha },
  base: { ref: raw.base.ref },
  merged: raw.merged ?? raw.merged_at !== null,
  mergeable: raw.mergeable ?? null,
  mergeableState: raw.mergeable_state ?? "unknown",
  htmlUrl: raw.html_url,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  mergedAt: raw.merged_at,
});

type RawWorkflowRun = {
  id: number;
  name: string | null;
  workflow_id: number;
  run_attempt?: number;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  run_started_at?: string | null;
  updated_at: string;
};

// A workflow run read as the check run GitHub Actions would have created for it; only the newest
// attempt of each workflow counts, as `filter=latest` does for check runs.
const latestWorkflowRuns = (runs: RawWorkflowRun[]): CheckRun[] => {
  const latest = new Map<number, RawWorkflowRun>();
  for (const run of runs) {
    const known = latest.get(run.workflow_id);
    // A re-run keeps the id and bumps the attempt; a new push starts a run with a larger id.
    const newer = !known || run.id > known.id || (run.id === known.id && (run.run_attempt ?? 1) > (known.run_attempt ?? 1));
    if (newer) latest.set(run.workflow_id, run);
  }
  return [...latest.values()].map((run) => ({
    id: run.id,
    name: run.name ?? `workflow ${run.workflow_id}`,
    status: (run.status === "completed" ? "completed" : run.status === "in_progress" ? "in_progress" : "queued") as CheckRun["status"],
    conclusion: (run.status === "completed" ? run.conclusion : null) as CheckRun["conclusion"],
    htmlUrl: run.html_url,
    startedAt: run.run_started_at ?? null,
    completedAt: run.status === "completed" ? run.updated_at : null,
  }));
};

const toCheckRun = (raw: RawCheckRun): CheckRun => ({
  id: raw.id,
  name: raw.name,
  status: raw.status as CheckRun["status"],
  conclusion: raw.conclusion as CheckRun["conclusion"],
  htmlUrl: raw.html_url,
  startedAt: raw.started_at,
  completedAt: raw.completed_at,
});

const toStatus = (raw: RawStatus): CommitStatus => ({
  context: raw.context,
  state: raw.state as CommitStatus["state"],
  targetUrl: raw.target_url,
  updatedAt: raw.updated_at,
});

const byUpdatedAt = <T extends { updatedAt: string }>(a: T, b: T): number => Date.parse(a.updatedAt) - Date.parse(b.updatedAt);

// Parses `<url>; rel="next"` out of a Link header.
export const nextLink = (link: string | null): string | undefined => {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
};

// GitHub REST over fetch for one repository. Mutations run one at a time with a pause between them.
export class GitHubRestAdapter implements GitHubPort {
  private readonly _token: string;
  private readonly _owner: string;
  private readonly _repo: string;
  private readonly _clock: Clock;
  private readonly _userAgent: string;
  private readonly _fetch: FetchLike;
  private readonly _baseUrl: string;
  private readonly _mutationPauseMs: number;
  private readonly _mergePollIntervalMs: number;
  private readonly _mergeTimeoutMs: number;
  private _mutations: Promise<unknown> = Promise.resolve();
  private _lastMutationAt: number | undefined;

  constructor(options: GitHubRestOptions) {
    this._token = options.token;
    this._owner = options.owner;
    this._repo = options.repo;
    this._clock = options.clock;
    this._userAgent = options.userAgent;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._baseUrl = (options.baseUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, "");
    this._mutationPauseMs = options.mutationPauseMs ?? 1_000;
    this._mergePollIntervalMs = options.mergePollIntervalMs ?? 2_500;
    this._mergeTimeoutMs = options.mergeTimeoutMs ?? 120_000;
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    const reply = await this._request("GET", "/user");
    return { login: (reply.json as RawUser).login };
  }

  // Metadata comes from the repository itself. Write permissions are probed with requests that fail
  // validation before they change anything: GitHub answers 403 when the token lacks the permission
  // and 404 or 422 when it has it. A repository the token cannot see at all comes back as 404.
  async checkAccess(): Promise<RepositoryAccess> {
    const fullName = `${this._owner}/${this._repo}`;
    const repository = await this._request("GET", this._repoPath(""), { allow: [403, 404] });
    if (repository.status === 403 || repository.status === 404) {
      return {
        fullName,
        defaultBranch: null,
        permissions: { metadataRead: false, contentsWrite: false, issuesWrite: false, pullRequestsWrite: false, actionsRead: false, statusesRead: false },
      };
    }
    const raw = repository.json as RawRepository;
    const branch = raw.default_branch ?? "HEAD";
    // The Merge Stage reads the CI of a pull request: Actions runs and commit statuses.
    const [contentsWrite, issuesWrite, pullRequestsWrite, actionsRead, statusesRead] = await Promise.all([
      this._probeWrite("POST", this._repoPath("/git/refs")),
      this._probeWrite("PATCH", this._repoPath("/issues/0")),
      this._probeWrite("PATCH", this._repoPath("/pulls/0")),
      this._probeRead(this._repoPath("/actions/runs"), { per_page: 1 }),
      this._probeRead(this._repoPath(`/commits/${encodeURIComponent(branch)}/status`)),
    ]);
    return {
      fullName: raw.full_name ?? fullName,
      defaultBranch: raw.default_branch ?? null,
      permissions: { metadataRead: true, contentsWrite, issuesWrite, pullRequestsWrite, actionsRead, statusesRead },
    };
  }

  async pollIssues(query: PollQuery): Promise<PollResult<Issue>> {
    const result = await this._pollPages<RawIssue>(this._repoPath("/issues"), {
      state: "all",
      sort: "updated",
      direction: "desc",
      since: query.since,
      per_page: PER_PAGE,
    }, query.etag);
    if (result.status === "notModified") return result;
    return { status: "ok", items: result.items.map(toIssue).sort(byUpdatedAt), etag: result.etag };
  }

  async pollIssueComments(query: PollQuery): Promise<PollResult<IssueComment>> {
    const result = await this._pollPages<RawComment>(this._repoPath("/issues/comments"), {
      sort: "updated",
      direction: "desc",
      since: query.since,
      per_page: PER_PAGE,
    }, query.etag);
    if (result.status === "notModified") return result;
    return { status: "ok", items: result.items.map(toComment).sort(byUpdatedAt), etag: result.etag };
  }

  async listIssues(filter: IssueFilter): Promise<Issue[]> {
    const raw = await this._paginate<RawIssue>(this._repoPath("/issues"), {
      state: filter.state ?? "open",
      milestone: filter.milestone === undefined ? undefined : String(filter.milestone),
      labels: filter.labels && filter.labels.length > 0 ? filter.labels.join(",") : undefined,
      assignee: filter.assignee,
      per_page: PER_PAGE,
    });
    return raw.map(toIssue).filter((issue) => !issue.isPullRequest);
  }

  async getIssue(number: IssueNumber): Promise<Issue> {
    const reply = await this._request("GET", this._repoPath(`/issues/${number}`));
    return toIssue(reply.json as RawIssue);
  }

  updateIssue(number: IssueNumber, patch: IssuePatch): Promise<Issue> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.body !== undefined) body.body = patch.body;
    if (patch.state !== undefined) body.state = patch.state;
    if (patch.stateReason !== undefined) body.state_reason = patch.stateReason;
    if (patch.milestone !== undefined) body.milestone = patch.milestone;
    return this._mutate(async () => {
      const reply = await this._request("PATCH", this._repoPath(`/issues/${number}`), { body });
      return toIssue(reply.json as RawIssue);
    });
  }

  addAssignees(number: IssueNumber, logins: string[]): Promise<void> {
    return this._mutate(async () => {
      await this._request("POST", this._repoPath(`/issues/${number}/assignees`), { body: { assignees: logins } });
    });
  }

  removeAssignees(number: IssueNumber, logins: string[]): Promise<void> {
    return this._mutate(async () => {
      await this._request("DELETE", this._repoPath(`/issues/${number}/assignees`), { body: { assignees: logins } });
    });
  }

  addLabels(number: IssueNumber, labels: string[]): Promise<void> {
    return this._mutate(async () => {
      await this._request("POST", this._repoPath(`/issues/${number}/labels`), { body: { labels } });
    });
  }

  // 404 means the label is not on the issue any more, which is the state we want.
  removeLabel(number: IssueNumber, label: string): Promise<void> {
    return this._mutate(async () => {
      await this._request("DELETE", this._repoPath(`/issues/${number}/labels/${encodeURIComponent(label)}`), {
        allow: [404],
      });
    });
  }

  async listSubIssues(number: IssueNumber): Promise<Issue[]> {
    const raw = await this._paginate<RawIssue>(this._repoPath(`/issues/${number}/sub_issues`), { per_page: PER_PAGE });
    return raw.map(toIssue);
  }

  async listIssueComments(number: IssueNumber): Promise<IssueComment[]> {
    const raw = await this._paginate<RawComment>(this._repoPath(`/issues/${number}/comments`), { per_page: PER_PAGE });
    return raw.map(toComment);
  }

  createIssueComment(number: IssueNumber, body: string): Promise<IssueComment> {
    return this._mutate(async () => {
      const reply = await this._request("POST", this._repoPath(`/issues/${number}/comments`), { body: { body } });
      return toComment(reply.json as RawComment);
    });
  }

  updateIssueComment(id: CommentId, body: string): Promise<IssueComment> {
    return this._mutate(async () => {
      const reply = await this._request("PATCH", this._repoPath(`/issues/comments/${id}`), { body: { body } });
      return toComment(reply.json as RawComment);
    });
  }

  addCommentReaction(id: CommentId, content: ReactionContent): Promise<void> {
    return this._mutate(async () => {
      await this._request("POST", this._repoPath(`/issues/comments/${id}/reactions`), { body: { content } });
    });
  }

  async listMilestones(state: IssueState | "all"): Promise<Milestone[]> {
    const raw = await this._paginate<RawMilestone>(this._repoPath("/milestones"), { state, per_page: PER_PAGE });
    return raw.map(toMilestone).sort((a, b) => a.number - b.number);
  }

  async getMilestone(number: MilestoneNumber): Promise<Milestone> {
    const reply = await this._request("GET", this._repoPath(`/milestones/${number}`));
    return toMilestone(reply.json as RawMilestone);
  }

  updateMilestone(number: MilestoneNumber, patch: { state: IssueState }): Promise<Milestone> {
    return this._mutate(async () => {
      const reply = await this._request("PATCH", this._repoPath(`/milestones/${number}`), { body: patch });
      return toMilestone(reply.json as RawMilestone);
    });
  }

  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    return this._mutate(async () => {
      const reply = await this._request("POST", this._repoPath("/pulls"), { body: input });
      return toPull(reply.json as RawPull);
    });
  }

  async getPullRequest(number: PullNumber): Promise<PullRequest> {
    const reply = await this._request("GET", this._repoPath(`/pulls/${number}`));
    return toPull(reply.json as RawPull);
  }

  async listPullRequests(filter: PullRequestFilter): Promise<PullRequest[]> {
    const head = filter.head === undefined ? undefined : filter.head.includes(":") ? filter.head : `${this._owner}:${filter.head}`;
    const raw = await this._paginate<RawPull>(this._repoPath("/pulls"), {
      state: filter.state ?? "open",
      head,
      base: filter.base,
      per_page: PER_PAGE,
    });
    return raw.map(toPull);
  }

  updatePullRequest(number: PullNumber, patch: PullRequestPatch): Promise<PullRequest> {
    return this._mutate(async () => {
      const reply = await this._request("PATCH", this._repoPath(`/pulls/${number}`), { body: patch });
      return toPull(reply.json as RawPull);
    });
  }

  // Squash merge through `merge-async`, polling its status until GitHub reports the outcome.
  mergePullRequest(number: PullNumber, input: MergeInput): Promise<MergeResult> {
    return this._mutate(async () => {
      const pull = await this.getPullRequest(number);
      const reply = await this._request("PUT", this._repoPath(`/pulls/${number}/merge-async`), {
        body: {
          merge_method: input.method,
          merge_action: "direct_merge",
          commit_title: input.commitTitle,
          commit_message: input.commitMessage,
          sha: pull.head.sha,
        },
        allow: [400, 405, 409, 422],
      });
      const json = reply.json as RawMergeAsync;
      if (reply.status === 200 && json.status === "merged") return { merged: true, sha: json.details?.sha ?? "" };
      const uuid = json.details?.uuid;
      if ((reply.status === 202 || reply.status === 200 || reply.status === 409) && uuid !== undefined) {
        return this._awaitMerge(number, uuid);
      }
      return { merged: false, reason: json.message ?? json.details?.message ?? `merge-async answered ${reply.status}` };
    });
  }

  // 422 (reference does not exist) means the branch is already gone.
  deleteBranch(name: string): Promise<void> {
    return this._mutate(async () => {
      await this._request("DELETE", this._repoPath(`/git/refs/heads/${name}`), { allow: [404, 422] });
    });
  }

  // Check runs need the `checks` permission, which fine-grained tokens cannot have; such a token
  // reads the CI of the commit from GitHub Actions instead.
  async listCheckRuns(ref: string): Promise<CheckRun[]> {
    const reply = await this._request("GET", this._repoPath(`/commits/${ref}/check-runs`), {
      query: { per_page: PER_PAGE, filter: "latest" },
      allow: [403],
    });
    if (reply.status !== 403) return ((reply.json as { check_runs: RawCheckRun[] }).check_runs ?? []).map(toCheckRun);
    const runs = await this._request("GET", this._repoPath("/actions/runs"), { query: { head_sha: ref, per_page: PER_PAGE }, allow: [403] });
    if (runs.status === 403) {
      throw new GitHubError(403, "the token can read neither check runs nor GitHub Actions: grant it Actions: read");
    }
    return latestWorkflowRuns((runs.json as { workflow_runs: RawWorkflowRun[] }).workflow_runs ?? []);
  }

  async listCommitStatuses(ref: string): Promise<CommitStatus[]> {
    const reply = await this._request("GET", this._repoPath(`/commits/${ref}/status`));
    return ((reply.json as { statuses: RawStatus[] }).statuses ?? []).map(toStatus);
  }

  // Internals

  // An empty repository has no commit to read the status of (404, 409, 422); only 403 means no permission.
  private async _probeRead(path: string, query?: Query): Promise<boolean> {
    const reply = await this._request("GET", path, { ...(query ? { query } : {}), allow: [403, 404, 409, 422] });
    return reply.status !== 403;
  }

  private async _probeWrite(method: string, path: string): Promise<boolean> {
    const reply = await this._request(method, path, { body: {}, allow: [403, 404, 422] });
    return reply.status !== 403;
  }

  private _repoPath(suffix: string): string {
    return `/repos/${this._owner}/${this._repo}${suffix}`;
  }

  private async _awaitMerge(number: PullNumber, uuid: string): Promise<MergeResult> {
    const deadline = this._clock.now() + this._mergeTimeoutMs;
    for (;;) {
      await this._clock.sleep(this._mergePollIntervalMs);
      const reply = await this._request("GET", this._repoPath(`/pulls/${number}/merge-async/${uuid}`), { allow: [404] });
      const json = reply.json as RawMergeAsync;
      if (reply.status !== 404) {
        if (json.status === "merged") return { merged: true, sha: json.details?.sha ?? "" };
        if (json.status === "failed") return { merged: false, reason: json.details?.message ?? "merge failed" };
      }
      if (reply.status === 404 || this._clock.now() >= deadline) {
        const merged = await this._request("GET", this._repoPath(`/pulls/${number}/merge`), { allow: [404] });
        if (merged.status === 204) return { merged: true, sha: json.details?.sha ?? "" };
        return { merged: false, reason: `merge not confirmed after ${this._mergeTimeoutMs} ms` };
      }
    }
  }

  // Mutations are serialized and spaced out by `mutationPauseMs`, measured on the Clock.
  private _mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._mutations.then(async () => {
      if (this._lastMutationAt !== undefined) {
        const wait = this._lastMutationAt + this._mutationPauseMs - this._clock.now();
        if (wait > 0) await this._clock.sleep(wait);
      }
      try {
        return await fn();
      } finally {
        this._lastMutationAt = this._clock.now();
      }
    });
    this._mutations = run.catch(() => undefined);
    return run;
  }

  private async _pollPages<T>(
    path: string,
    query: Query,
    etag: string | undefined,
  ): Promise<{ status: "notModified" } | { status: "ok"; items: T[]; etag: string | undefined }> {
    const options: RequestOptions = { query, allow: [304] };
    if (etag !== undefined) options.etag = etag;
    const first = await this._request("GET", path, options);
    if (first.status === 304) return { status: "notModified" };
    const items = [...(first.json as T[])];
    let next = nextLink(first.headers.get("link"));
    while (next !== undefined) {
      const page = await this._request("GET", next);
      items.push(...(page.json as T[]));
      next = nextLink(page.headers.get("link"));
    }
    return { status: "ok", items, etag: first.headers.get("etag") ?? undefined };
  }

  private async _paginate<T>(path: string, query: Query): Promise<T[]> {
    const result = await this._pollPages<T>(path, query, undefined);
    return result.status === "ok" ? result.items : [];
  }

  private async _request(method: string, pathOrUrl: string, options: RequestOptions = {}): Promise<Reply> {
    const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${this._baseUrl}${pathOrUrl}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": this._userAgent,
    };
    if (options.etag !== undefined) headers["If-None-Match"] = options.etag;
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await this._fetch(url.toString(), init);
    const json = await parseBody(response);
    if (response.ok || options.allow?.includes(response.status)) {
      return { status: response.status, headers: response.headers, json };
    }
    const message = (json as { message?: string } | null)?.message ?? response.statusText;
    const detail = `${method} ${url.pathname}: ${response.status} ${message}`;
    if (response.status === 404) throw new GitHubNotFoundError(detail);
    throw new GitHubError(response.status, rateLimitHint(response) ?? detail);
  }
}

const parseBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204 || response.status === 304) return null;
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const rateLimitHint = (response: Response): string | undefined => {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = response.headers.get("retry-after");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  if (retryAfter) return `rate limited: retry after ${retryAfter} s`;
  if (remaining === "0" && reset) return `rate limited: resets at ${new Date(Number(reset) * 1000).toISOString()}`;
  return undefined;
};
