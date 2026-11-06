// Wire types of the HTTP and WebSocket API, shared with the client bundle (type-only imports there).
import type { AgentRole, AgentState } from "../index/agents.js";
import type { LimitSample } from "../index/limit-samples.js";
import type { Task, TaskStage, Transition } from "../index/tasks.js";
import type { InstallationSnapshot, PauseSource } from "../orchestrator/installation-state.js";

export type HealthResponse = {
  status: "ok";
  version: string;
  schemaVersion: number;
  uptimeMs: number;
};

export type SessionResponse = {
  authenticated: boolean;
  // False until the Installation has a password hash; the login screen explains how to set one.
  passwordSet: boolean;
};

export type LoginRequest = { password: string };

// The Agent of the current attempt of a Task, as the card shows it.
export type AgentView = {
  id: number;
  role: AgentRole;
  state: AgentState;
  lastTurnAt: string | null;
  createdAt: string;
};

// An open Request to the human of a Task; the question text comes from the Request comment.
export type RequestView = {
  id: number;
  agentId: number;
  commentId: number | null;
  commentUrl: string | null;
  createdAt: string;
  question: string | null;
  options: string[];
};

export type TaskView = Task & {
  htmlUrl: string | null;
  pullUrl: string | null;
  transitions: Transition[];
  agent: AgentView | null;
  request: RequestView | null;
};

// A Task that left the Pipeline, with the reason and the time of its last transition.
export type FinishedTaskView = TaskView & { reason: string | null; finishedAt: string | null };
export type StuckTaskView = FinishedTaskView;

export type ReadyTaskView = {
  issueNumber: number;
  title: string;
  milestone: { number: number; title: string } | null;
  htmlUrl: string;
};

export type TasksResponse = {
  slots: { used: number; max: number };
  // Limit of QA rounds; a Task in `qa` is in round `round + 1` of it.
  maxQaRounds: number;
  inProgress: TaskView[];
  ready: ReadyTaskView[];
  stuck: StuckTaskView[];
  cancelled: FinishedTaskView[];
};

export type ProductView = { fullName: string; htmlUrl: string };

export type InstallationResponse = InstallationSnapshot & {
  slots: { used: number; max: number };
  product: ProductView | null;
  version: string;
};

// Body of `PUT /api/installation/pause`: a human pauses or resumes the Installation.
export type PauseRequest = { paused: boolean; reason?: string; source?: PauseSource };

export type DigestRequest = {
  id: number;
  issueNumber: number;
  title: string | null;
  createdAt: string;
  open: boolean;
  question: string | null;
};

export type DigestDone = { issueNumber: number; title: string | null; pullNumber: number | null; pullUrl: string | null; at: string };

export type DigestStuck = { issueNumber: number; title: string | null; reason: string | null; at: string };

// What happened since the previous visit of the human: Requests, finished Tasks and dead ends.
export type DigestResponse = {
  since: string;
  requests: DigestRequest[];
  done: DigestDone[];
  stuck: DigestStuck[];
};

// Events pushed to the UI over `/ws`. They announce a change; the client refetches the affected queries.
export type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "transition"; issueNumber: number; from: TaskStage | null; to: TaskStage; reason: string | null; at: string }
  | { type: "task"; issueNumber: number; stage: TaskStage; round: number }
  | { type: "agent"; agentId: number; issueNumber: number | null; role: AgentRole; state: AgentState; previous: AgentState }
  | { type: "request"; requestId: number; issueNumber: number; open: boolean }
  | { type: "installation"; installation: InstallationResponse };

// Statistics page

export type StatsPeriodDays = 7 | 30;

export type StageTimeView = {
  stage: "implement" | "qa" | "merge";
  count: number;
  meanMs: number | null;
  medianMs: number | null;
};

export type RoundsBucketView = { rounds: number; tasks: number };

// Aggregates over `transitions` for the last `days`: takes, merges, dead ends, Stage times and QA Rounds.
export type StatsResponse = {
  days: StatsPeriodDays;
  since: string;
  taken: number;
  done: number;
  stuck: number;
  stages: StageTimeView[];
  rounds: { tasks: number; mean: number | null; buckets: RoundsBucketView[] };
};

export type LimitHistoryResponse = {
  days: StatsPeriodDays;
  since: string;
  samples: LimitSample[];
};

// One line of the Orchestrator journal; `raw` is the full JSON line for the expanded view.
export type LogEntryView = { at: string | null; level: string | null; msg: string; raw: string };

export type LogsResponse = {
  lines: number;
  source: "journal" | "buffer";
  entries: LogEntryView[];
};
