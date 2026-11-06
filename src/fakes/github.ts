import { createHash } from "node:crypto";
import type { CommentId, IssueId, IssueNumber, MilestoneNumber, PullNumber } from "../ids.js";
import {
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
} from "../ports/github.js";
import { CallLog } from "./call-log.js";

export type IssueSeed = Partial<Omit<Issue, "number">> & { number: number };
export type MilestoneSeed = Partial<Omit<Milestone, "number">> & { number: number };
export type PullRequestSeed = Partial<Omit<PullRequest, "number" | "head">> & {
  number: number;
  head?: Partial<PullRequest["head"]>;
};
export type CheckRunSeed = Partial<CheckRun> & { name: string };
export type CommitStatusSeed = Partial<CommitStatus> & { context: string };

export type Reaction = {
  commentId: CommentId;
  content: ReactionContent;
  user: string;
};

const DEFAULT_REPO_URL = "https://github.com/example/product";

// In-memory GitHub repository. Port methods record calls; `human*` helpers change state silently,
// the way a person would through the web UI.
export class FakeGitHubPort implements GitHubPort {
  readonly log = new CallLog();
  readonly reactions: Reaction[] = [];
  readonly deletedBranches: string[] = [];
  login = "auto-dev-bot";
  humanLogin = "alice";
  repoUrl = DEFAULT_REPO_URL;
  private _nextIssueId = 100_000;
  private _nextCommentId = 1;
  private _nextPullNumber = 1;
  private _nextCheckRunId = 1;
  private readonly _issues = new Map<IssueNumber, Issue>();
  private readonly _comments = new Map<CommentId, IssueComment>();
  private readonly _milestones = new Map<MilestoneNumber, Milestone>();
  private readonly _pulls = new Map<PullNumber, PullRequest>();
  private readonly _checkRuns = new Map<string, CheckRun[]>();
  private readonly _statuses = new Map<string, CommitStatus[]>();
  private readonly _now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this._now = options.now ?? (() => Date.now());
  }

  get calls() {
    return this.log.calls;
  }

  // Seeding and human actions

  seedMilestone(seed: MilestoneSeed): Milestone {
    const number = seed.number as MilestoneNumber;
    const milestone: Milestone = {
      number,
      title: seed.title ?? `Milestone ${number}`,
      state: seed.state ?? "open",
      description: seed.description ?? "",
      openIssues: seed.openIssues ?? 0,
      closedIssues: seed.closedIssues ?? 0,
      createdAt: seed.createdAt ?? this._iso(),
      htmlUrl: seed.htmlUrl ?? `${this.repoUrl}/milestone/${number}`,
    };
    this._milestones.set(number, milestone);
    return clone(milestone);
  }

  seedIssue(seed: IssueSeed): Issue {
    const number = seed.number as IssueNumber;
    const now = this._iso();
    const issue: Issue = {
      id: seed.id ?? (this._nextIssueId++ as IssueId),
      number,
      title: seed.title ?? `Issue ${number}`,
      body: seed.body ?? "",
      state: seed.state ?? "open",
      stateReason: seed.stateReason ?? null,
      labels: [...(seed.labels ?? [])],
      assignees: [...(seed.assignees ?? [])],
      milestone: seed.milestone ?? null,
      type: seed.type ?? null,
      isPullRequest: seed.isPullRequest ?? false,
      dependencies: seed.dependencies ?? { blockedBy: 0, blocking: 0, totalBlockedBy: 0, totalBlocking: 0 },
      subIssues: seed.subIssues ?? null,
      parentIssueNumber: seed.parentIssueNumber ?? null,
      author: seed.author ?? this.humanLogin,
      htmlUrl: seed.htmlUrl ?? `${this.repoUrl}/issues/${number}`,
      createdAt: seed.createdAt ?? now,
      updatedAt: seed.updatedAt ?? now,
      closedAt: seed.closedAt ?? null,
    };
    this._issues.set(number, issue);
    return clone(issue);
  }

  seedPullRequest(seed: PullRequestSeed): PullRequest {
    const number = seed.number as PullNumber;
    const now = this._iso();
    const pull: PullRequest = {
      number,
      title: seed.title ?? `PR ${number}`,
      body: seed.body ?? "",
      state: seed.state ?? "open",
      head: { ref: seed.head?.ref ?? `branch-${number}`, sha: seed.head?.sha ?? `sha-${number}` },
      base: seed.base ?? { ref: "main" },
      merged: seed.merged ?? false,
      mergeable: seed.mergeable ?? true,
      mergeableState: seed.mergeableState ?? "clean",
      htmlUrl: seed.htmlUrl ?? `${this.repoUrl}/pull/${number}`,
      createdAt: seed.createdAt ?? now,
      updatedAt: seed.updatedAt ?? now,
      mergedAt: seed.mergedAt ?? null,
    };
    this._pulls.set(number, pull);
    if (number >= this._nextPullNumber) this._nextPullNumber = number + 1;
    return clone(pull);
  }

  seedCheckRun(ref: string, seed: CheckRunSeed): CheckRun {
    const run: CheckRun = {
      id: seed.id ?? this._nextCheckRunId++,
      name: seed.name,
      status: seed.status ?? "completed",
      conclusion: seed.conclusion ?? (seed.status && seed.status !== "completed" ? null : "success"),
      htmlUrl: seed.htmlUrl ?? `${this.repoUrl}/runs/${seed.id ?? this._nextCheckRunId}`,
      startedAt: seed.startedAt ?? this._iso(),
      completedAt: seed.completedAt ?? null,
    };
    const runs = this._checkRuns.get(ref) ?? [];
    this._checkRuns.set(ref, [...runs.filter((existing) => existing.id !== run.id), run]);
    return run;
  }

  seedCommitStatus(ref: string, seed: CommitStatusSeed): CommitStatus {
    const status: CommitStatus = {
      context: seed.context,
      state: seed.state ?? "success",
      targetUrl: seed.targetUrl ?? null,
      updatedAt: seed.updatedAt ?? this._iso(),
    };
    const statuses = this._statuses.get(ref) ?? [];
    this._statuses.set(ref, [...statuses.filter((existing) => existing.context !== status.context), status]);
    return status;
  }

  // Snapshots of the current state for assertions.

  issue(number: number): Issue {
    return clone(this._issue(number as IssueNumber));
  }

  pull(number: number): PullRequest {
    return clone(this._pull(number as PullNumber));
  }

  milestone(number: number): Milestone {
    return clone(this._milestone(number as MilestoneNumber));
  }

  commentsOf(number: number): IssueComment[] {
    return [...this._comments.values()].filter((comment) => comment.issueNumber === number).map(clone);
  }

  humanComment(number: number, body: string, author = this.humanLogin): IssueComment {
    return clone(this._addComment(number as IssueNumber, body, author));
  }

  humanEditComment(id: number, body: string): IssueComment {
    return clone(this._editComment(id as CommentId, body));
  }

  humanDeleteComment(id: number): void {
    this._comments.delete(id as CommentId);
  }

  humanUpdateIssue(number: number, patch: IssuePatch): Issue {
    return clone(this._patchIssue(number as IssueNumber, patch));
  }

  humanSetLabels(number: number, labels: string[]): Issue {
    return clone(
      this._touchIssue(number as IssueNumber, (issue) => {
        issue.labels = [...labels];
      }),
    );
  }

  humanSetAssignees(number: number, assignees: string[]): Issue {
    return clone(
      this._touchIssue(number as IssueNumber, (issue) => {
        issue.assignees = [...assignees];
      }),
    );
  }

  humanSetDependencies(number: number, dependencies: Partial<Issue["dependencies"]>): Issue {
    return clone(
      this._touchIssue(number as IssueNumber, (issue) => {
        issue.dependencies = { ...issue.dependencies, ...dependencies };
      }),
    );
  }

  humanMergePullRequest(number: number): PullRequest {
    return clone(
      this._touchPull(number as PullNumber, (pull) => {
        pull.merged = true;
        pull.state = "closed";
        pull.mergedAt = this._iso();
      }),
    );
  }

  // An Agent pushed to the branch of the pull request: new head, mergeability as GitHub would compute it.
  agentPush(number: number, sha: string, mergeable: boolean | null = true): PullRequest {
    return clone(
      this._touchPull(number as PullNumber, (pull) => {
        pull.head = { ...pull.head, sha };
        pull.mergeable = mergeable;
        pull.mergeableState = mergeable === null ? "unknown" : mergeable ? "clean" : "dirty";
      }),
    );
  }

  humanSetMergeable(number: number, mergeable: boolean | null, mergeableState?: string): PullRequest {
    return clone(
      this._touchPull(number as PullNumber, (pull) => {
        pull.mergeable = mergeable;
        pull.mergeableState = mergeableState ?? (mergeable === null ? "unknown" : mergeable ? "clean" : "dirty");
      }),
    );
  }

  // GitHubPort

  async getAuthenticatedUser(): Promise<{ login: string }> {
    this.log.record("getAuthenticatedUser");
    return { login: this.login };
  }

  async pollIssues(query: PollQuery): Promise<PollResult<Issue>> {
    this.log.record("pollIssues", query);
    return this._poll([...this._issues.values()], query);
  }

  async pollIssueComments(query: PollQuery): Promise<PollResult<IssueComment>> {
    this.log.record("pollIssueComments", query);
    return this._poll([...this._comments.values()], query);
  }

  async listIssues(filter: IssueFilter): Promise<Issue[]> {
    this.log.record("listIssues", filter);
    const state = filter.state ?? "open";
    return [...this._issues.values()]
      .filter((issue) => !issue.isPullRequest)
      .filter((issue) => state === "all" || issue.state === state)
      .filter((issue) => matchesMilestone(issue, filter.milestone))
      .filter((issue) => (filter.labels ?? []).every((label) => issue.labels.includes(label)))
      .filter((issue) => matchesAssignee(issue, filter.assignee))
      .sort((a, b) => a.number - b.number)
      .map(clone);
  }

  async getIssue(number: IssueNumber): Promise<Issue> {
    this.log.record("getIssue", number);
    return clone(this._issue(number));
  }

  async updateIssue(number: IssueNumber, patch: IssuePatch): Promise<Issue> {
    this.log.record("updateIssue", number, patch);
    return clone(this._patchIssue(number, patch));
  }

  async addAssignees(number: IssueNumber, logins: string[]): Promise<void> {
    this.log.record("addAssignees", number, logins);
    this._touchIssue(number, (issue) => {
      issue.assignees = [...new Set([...issue.assignees, ...logins])];
    });
  }

  async removeAssignees(number: IssueNumber, logins: string[]): Promise<void> {
    this.log.record("removeAssignees", number, logins);
    this._touchIssue(number, (issue) => {
      issue.assignees = issue.assignees.filter((login) => !logins.includes(login));
    });
  }

  async addLabels(number: IssueNumber, labels: string[]): Promise<void> {
    this.log.record("addLabels", number, labels);
    this._touchIssue(number, (issue) => {
      issue.labels = [...new Set([...issue.labels, ...labels])];
    });
  }

  async removeLabel(number: IssueNumber, label: string): Promise<void> {
    this.log.record("removeLabel", number, label);
    const issue = this._issue(number);
    if (!issue.labels.includes(label)) throw new GitHubNotFoundError(`label ${label} is not on issue #${number}`);
    this._touchIssue(number, (current) => {
      current.labels = current.labels.filter((existing) => existing !== label);
    });
  }

  async listSubIssues(number: IssueNumber): Promise<Issue[]> {
    this.log.record("listSubIssues", number);
    this._issue(number);
    return [...this._issues.values()]
      .filter((issue) => issue.parentIssueNumber === number)
      .sort((a, b) => a.number - b.number)
      .map(clone);
  }

  async listIssueComments(number: IssueNumber): Promise<IssueComment[]> {
    this.log.record("listIssueComments", number);
    this._issue(number);
    return this.commentsOf(number).map(clone);
  }

  async createIssueComment(number: IssueNumber, body: string): Promise<IssueComment> {
    this.log.record("createIssueComment", number, body);
    return clone(this._addComment(number, body, this.login));
  }

  async updateIssueComment(id: CommentId, body: string): Promise<IssueComment> {
    this.log.record("updateIssueComment", id, body);
    return clone(this._editComment(id, body));
  }

  async addCommentReaction(id: CommentId, content: ReactionContent): Promise<void> {
    this.log.record("addCommentReaction", id, content);
    this._comment(id);
    this.reactions.push({ commentId: id, content, user: this.login });
  }

  async listMilestones(state: IssueState | "all"): Promise<Milestone[]> {
    this.log.record("listMilestones", state);
    return [...this._milestones.values()]
      .filter((milestone) => state === "all" || milestone.state === state)
      .sort((a, b) => a.number - b.number)
      .map(clone);
  }

  async getMilestone(number: MilestoneNumber): Promise<Milestone> {
    this.log.record("getMilestone", number);
    return clone(this._milestone(number));
  }

  async updateMilestone(number: MilestoneNumber, patch: { state: IssueState }): Promise<Milestone> {
    this.log.record("updateMilestone", number, patch);
    const milestone = this._milestone(number);
    milestone.state = patch.state;
    return clone(milestone);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    this.log.record("createPullRequest", input);
    const duplicate = [...this._pulls.values()].find((pull) => pull.state === "open" && pull.head.ref === input.head);
    if (duplicate) throw new Error(`a pull request already exists for ${input.head}`);
    return clone(
      this.seedPullRequest({
        number: this._nextPullNumber,
        title: input.title,
        body: input.body,
        head: { ref: input.head },
        base: { ref: input.base },
      }),
    );
  }

  async getPullRequest(number: PullNumber): Promise<PullRequest> {
    this.log.record("getPullRequest", number);
    return clone(this._pull(number));
  }

  async listPullRequests(filter: PullRequestFilter): Promise<PullRequest[]> {
    this.log.record("listPullRequests", filter);
    const state = filter.state ?? "open";
    const head = filter.head?.includes(":") ? filter.head.slice(filter.head.indexOf(":") + 1) : filter.head;
    return [...this._pulls.values()]
      .filter((pull) => state === "all" || pull.state === state)
      .filter((pull) => head === undefined || pull.head.ref === head)
      .filter((pull) => filter.base === undefined || pull.base.ref === filter.base)
      .sort((a, b) => b.number - a.number)
      .map(clone);
  }

  async updatePullRequest(number: PullNumber, patch: PullRequestPatch): Promise<PullRequest> {
    this.log.record("updatePullRequest", number, patch);
    return clone(
      this._touchPull(number, (pull) => {
        if (patch.title !== undefined) pull.title = patch.title;
        if (patch.body !== undefined) pull.body = patch.body;
        if (patch.state !== undefined) pull.state = patch.state;
      }),
    );
  }

  async mergePullRequest(number: PullNumber, input: MergeInput): Promise<MergeResult> {
    this.log.record("mergePullRequest", number, input);
    const pull = this._pull(number);
    if (pull.merged) return { merged: false, reason: "Pull Request is already merged" };
    if (pull.state !== "open") return { merged: false, reason: "Pull Request is not open" };
    if (pull.mergeable !== true) return { merged: false, reason: "Pull Request is not mergeable" };
    const sha = `merge-${number}`;
    this._touchPull(number, (current) => {
      current.merged = true;
      current.state = "closed";
      current.mergedAt = this._iso();
    });
    return { merged: true, sha };
  }

  async deleteBranch(name: string): Promise<void> {
    this.log.record("deleteBranch", name);
    this.deletedBranches.push(name);
  }

  async listCheckRuns(ref: string): Promise<CheckRun[]> {
    this.log.record("listCheckRuns", ref);
    return (this._checkRuns.get(ref) ?? []).map(clone);
  }

  async listCommitStatuses(ref: string): Promise<CommitStatus[]> {
    this.log.record("listCommitStatuses", ref);
    return (this._statuses.get(ref) ?? []).map(clone);
  }

  // Internals

  private _iso(): string {
    return new Date(this._now()).toISOString();
  }

  private _issue(number: IssueNumber): Issue {
    const issue = this._issues.get(number);
    if (!issue) throw new GitHubNotFoundError(`issue #${number} not found`);
    return issue;
  }

  private _pull(number: PullNumber): PullRequest {
    const pull = this._pulls.get(number);
    if (!pull) throw new GitHubNotFoundError(`pull request #${number} not found`);
    return pull;
  }

  private _milestone(number: MilestoneNumber): Milestone {
    const milestone = this._milestones.get(number);
    if (!milestone) throw new GitHubNotFoundError(`milestone ${number} not found`);
    return milestone;
  }

  private _comment(id: CommentId): IssueComment {
    const comment = this._comments.get(id);
    if (!comment) throw new GitHubNotFoundError(`comment ${id} not found`);
    return comment;
  }

  private _touchIssue(number: IssueNumber, change: (issue: Issue) => void): Issue {
    const issue = this._issue(number);
    change(issue);
    issue.updatedAt = this._iso();
    return issue;
  }

  private _touchPull(number: PullNumber, change: (pull: PullRequest) => void): PullRequest {
    const pull = this._pull(number);
    change(pull);
    pull.updatedAt = this._iso();
    return pull;
  }

  private _patchIssue(number: IssueNumber, patch: IssuePatch): Issue {
    return this._touchIssue(number, (issue) => {
      if (patch.title !== undefined) issue.title = patch.title;
      if (patch.body !== undefined) issue.body = patch.body;
      if (patch.milestone !== undefined) {
        issue.milestone = patch.milestone === null ? null : pick(this._milestone(patch.milestone), ["number", "title"]);
      }
      if (patch.state !== undefined && patch.state !== issue.state) {
        issue.state = patch.state;
        issue.closedAt = patch.state === "closed" ? this._iso() : null;
        issue.stateReason = patch.state === "closed" ? (patch.stateReason ?? "completed") : "reopened";
      } else if (patch.stateReason !== undefined) {
        issue.stateReason = patch.stateReason;
      }
    });
  }

  private _addComment(number: IssueNumber, body: string, author: string): IssueComment {
    this._issue(number);
    const id = this._nextCommentId++ as CommentId;
    const now = this._iso();
    const comment: IssueComment = {
      id,
      issueNumber: number,
      body,
      author,
      htmlUrl: `${this.repoUrl}/issues/${number}#issuecomment-${id}`,
      createdAt: now,
      updatedAt: now,
    };
    this._comments.set(id, comment);
    this._touchIssue(number, () => {});
    return comment;
  }

  private _editComment(id: CommentId, body: string): IssueComment {
    const comment = this._comment(id);
    comment.body = body;
    comment.updatedAt = this._iso();
    return comment;
  }

  // Repository-level polling: items updated at or after `since`, oldest first, with an ETag over the result.
  private _poll<T extends { updatedAt: string }>(items: T[], query: PollQuery): PollResult<T> {
    const since = query.since === undefined ? undefined : Date.parse(query.since);
    const selected = items
      .filter((item) => since === undefined || Date.parse(item.updatedAt) >= since)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .map(clone);
    const etag = `"${createHash("sha1").update(JSON.stringify(selected)).digest("hex")}"`;
    if (query.etag !== undefined && query.etag === etag) return { status: "notModified" };
    return { status: "ok", items: selected, etag };
  }
}

const clone = <T>(value: T): T => structuredClone(value);

const pick = <T, K extends keyof T>(value: T, keys: K[]): Pick<T, K> => {
  const result = {} as Pick<T, K>;
  for (const key of keys) result[key] = value[key];
  return result;
};

const matchesMilestone = (issue: Issue, filter: IssueFilter["milestone"]): boolean => {
  if (filter === undefined || filter === "*") return true;
  if (filter === "none") return issue.milestone === null;
  return issue.milestone?.number === filter;
};

const matchesAssignee = (issue: Issue, filter: IssueFilter["assignee"]): boolean => {
  if (filter === undefined || filter === "*") return true;
  if (filter === "none") return issue.assignees.length === 0;
  return issue.assignees.includes(filter);
};
