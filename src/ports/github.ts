import type { CommentId, IssueId, IssueNumber, MilestoneNumber, PullNumber } from "../ids.js";

export type IssueState = "open" | "closed";
export type IssueStateReason = "completed" | "not_planned" | "reopened" | "duplicate" | null;

export type MilestoneRef = {
  number: MilestoneNumber;
  title: string;
};

export type Milestone = MilestoneRef & {
  state: IssueState;
  description: string;
  openIssues: number;
  closedIssues: number;
  createdAt: string;
  htmlUrl: string;
};

export type DependenciesSummary = {
  // Open blockers only; `totalBlockedBy` also counts closed ones.
  blockedBy: number;
  blocking: number;
  totalBlockedBy: number;
  totalBlocking: number;
};

export type SubIssuesSummary = {
  total: number;
  completed: number;
};

export type Issue = {
  id: IssueId;
  number: IssueNumber;
  title: string;
  body: string;
  state: IssueState;
  stateReason: IssueStateReason;
  labels: string[];
  assignees: string[];
  milestone: MilestoneRef | null;
  // Organization issue type name (Task, Bug, Epic, Spec); null in repositories without types.
  type: string | null;
  isPullRequest: boolean;
  dependencies: DependenciesSummary;
  subIssues: SubIssuesSummary | null;
  parentIssueNumber: IssueNumber | null;
  author: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type IssueComment = {
  id: CommentId;
  issueNumber: IssueNumber;
  body: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type PullRequestState = "open" | "closed";

export type PullRequest = {
  number: PullNumber;
  title: string;
  body: string;
  state: PullRequestState;
  head: { ref: string; sha: string };
  base: { ref: string };
  merged: boolean;
  // null while GitHub is still computing mergeability.
  mergeable: boolean | null;
  mergeableState: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
};

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | null;

export type CheckRun = {
  id: number;
  name: string;
  status: CheckRunStatus;
  conclusion: CheckRunConclusion;
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type CommitStatusState = "pending" | "success" | "failure" | "error";

export type CommitStatus = {
  context: string;
  state: CommitStatusState;
  targetUrl: string | null;
  updatedAt: string;
};

export type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

export type PollQuery = {
  // ISO timestamp; only items updated at or after it are returned.
  since?: string;
  // ETag from the previous poll; a matching one yields `notModified`.
  etag?: string;
};

export type PollResult<T> =
  | { status: "ok"; items: T[]; etag: string | undefined }
  | { status: "notModified" };

export type IssueFilter = {
  state?: IssueState | "all";
  // Milestone number, "none" for issues without one, "*" for any.
  milestone?: MilestoneNumber | "none" | "*";
  labels?: string[];
  assignee?: string | "none" | "*";
};

export type IssuePatch = {
  title?: string;
  body?: string;
  state?: IssueState;
  stateReason?: Exclude<IssueStateReason, null>;
  milestone?: MilestoneNumber | null;
};

export type PullRequestFilter = {
  state?: PullRequestState | "all";
  // "owner:branch" or just "branch" for the same repository.
  head?: string;
  base?: string;
};

export type CreatePullRequestInput = {
  title: string;
  body: string;
  head: string;
  base: string;
};

export type PullRequestPatch = {
  title?: string;
  body?: string;
  state?: PullRequestState;
};

export type MergeInput = {
  method: "squash";
  commitTitle: string;
  commitMessage: string;
};

export type MergeResult = { merged: true; sha: string } | { merged: false; reason: string };

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubNotFoundError extends GitHubError {
  constructor(message: string) {
    super(404, message);
    this.name = "GitHubNotFoundError";
  }
}

// Everything the Orchestrator needs from one GitHub repository.
// Adapters talk REST; fakes keep the same state in memory.
export interface GitHubPort {
  getAuthenticatedUser(): Promise<{ login: string }>;

  // Repository-level polling endpoints: sorted by update time, with `since` and ETag support.
  pollIssues(query: PollQuery): Promise<PollResult<Issue>>;
  pollIssueComments(query: PollQuery): Promise<PollResult<IssueComment>>;

  listIssues(filter: IssueFilter): Promise<Issue[]>;
  getIssue(number: IssueNumber): Promise<Issue>;
  updateIssue(number: IssueNumber, patch: IssuePatch): Promise<Issue>;
  addAssignees(number: IssueNumber, logins: string[]): Promise<void>;
  removeAssignees(number: IssueNumber, logins: string[]): Promise<void>;
  addLabels(number: IssueNumber, labels: string[]): Promise<void>;
  removeLabel(number: IssueNumber, label: string): Promise<void>;
  listSubIssues(number: IssueNumber): Promise<Issue[]>;

  listIssueComments(number: IssueNumber): Promise<IssueComment[]>;
  createIssueComment(number: IssueNumber, body: string): Promise<IssueComment>;
  updateIssueComment(id: CommentId, body: string): Promise<IssueComment>;
  addCommentReaction(id: CommentId, content: ReactionContent): Promise<void>;

  listMilestones(state: IssueState | "all"): Promise<Milestone[]>;
  updateMilestone(number: MilestoneNumber, patch: { state: IssueState }): Promise<Milestone>;

  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  getPullRequest(number: PullNumber): Promise<PullRequest>;
  listPullRequests(filter: PullRequestFilter): Promise<PullRequest[]>;
  updatePullRequest(number: PullNumber, patch: PullRequestPatch): Promise<PullRequest>;
  mergePullRequest(number: PullNumber, input: MergeInput): Promise<MergeResult>;

  deleteBranch(name: string): Promise<void>;
  listCheckRuns(ref: string): Promise<CheckRun[]>;
  listCommitStatuses(ref: string): Promise<CommitStatus[]>;
}
