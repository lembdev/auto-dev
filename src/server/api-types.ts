// Wire types of the HTTP and WebSocket API, shared with the client bundle (type-only imports there).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRole, AgentState } from "../index/agents.js";
import type { LimitSample } from "../index/limit-samples.js";
import type { Task, TaskStage, Transition } from "../index/tasks.js";
import type { InstallationSnapshot, PauseSource } from "../orchestrator/installation-state.js";
import type { UpdatePhase, UpdateView } from "../orchestrator/update-coordinator.js";
import type { RepositoryAccess, RepositoryPermission } from "../ports/github.js";
import type { SettingsPatch, SettingsView } from "../setup/settings.js";
import type { SetupStatus, SetupStepId } from "../setup/setup.js";

export type { SetupStatus, SetupStepId, RepositoryAccess, RepositoryPermission, UpdatePhase, UpdateView };

// Bodies of the wizard steps.
export type SetupPasswordRequest = { password: string };
export type SetupRepositoryRequest = { repo: string; token: string };
export type SetupOauthRequest = { token: string };

// Result of the access check with the status that follows it.
export type SetupAccessResponse = {
  ok: boolean;
  error: string | null;
  access: RepositoryAccess | null;
  missing: RepositoryPermission[];
  status: SetupStatus;
};

export type SetupSmokeResponse = {
  ok: boolean;
  error: string | null;
  claudeVersion: string | null;
  model: string | null;
  status: SetupStatus;
};

export type SettingsResponse = SettingsView;
export type SettingsRequest = SettingsPatch;

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
  // The daily release check and the phase of an update under way.
  update: UpdateView;
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

// One message of an Agent's feed; `seq` orders the live stream of one Agent and names the seam
// after the history.
export type AgentFeedEntry = { seq: number; message: SDKMessage };

// `GET /api/tasks/:issue/agent/history`: the Session transcript of the Agent of the current attempt.
// The client subscribes to the live stream with `after: cursor` and misses nothing in between.
export type AgentHistoryResponse = {
  agent: AgentView;
  sessionId: string | null;
  history: SDKMessage[];
  cursor: number;
};

// `POST /api/tasks/:issue/agent/interrupt`: the Turn is interrupted, the Session stays.
export type InterruptResponse = { agent: AgentView };

// `POST /api/tasks/:issue/cancel`: the issue is closed, the Cancellation follows.
export type CancelResponse = { issueNumber: number; stage: TaskStage };

// One line of the Dialogue of a Task that has not reached the Session yet.
export type DialogueMessageView = {
  id: number;
  issueNumber: number;
  agentId: number | null;
  // "ui" for a line typed in the panel, "github" for a comment after an Answer.
  source: "ui" | "github";
  clientId: string;
  seq: number;
  text: string;
  createdAt: string;
};

// `GET /api/tasks/:issue/dialogue`: the queue of the Task, oldest first.
export type DialogueResponse = { messages: DialogueMessageView[] };

// `DELETE /api/tasks/:issue/dialogue/:id`: the line never reaches the Session.
export type RemoveDialogueResponse = { id: number };

// A frame of the Dialogue or an Answer typed in the UI. `clientId` names the tab's sender for good and
// `seq` only grows, so the server applies each frame once and answers every repeat with an `ack`.
export type DialogueFrame = { type: "dialogue"; clientId: string; seq: number; issueNumber: number; text: string };
export type AnswerFrame = { type: "answer"; clientId: string; seq: number; requestId: number; text: string };
// A line of the chat with the Planner: a Dialogue frame addressed `to: "planner"` instead of an issue.
// It shares the sender's `clientId` and `seq` with the Dialogue, so the same watermark makes it count once.
export type PlannerDialogueFrame = { type: "dialogue"; to: "planner"; clientId: string; seq: number; text: string };

export type AckOutcome = "applied" | "duplicate" | "rejected";

// The answer to one frame: `watermark` is the highest `seq` of this client the server has seen.
export type AckEvent = { type: "ack"; clientId: string; seq: number; watermark: number; outcome: AckOutcome; reason: string | null };

// Frames the client sends over `/ws`: the live feed of one Agent, from the message after `after`,
// and the frames of the Dialogue.
export type ClientMessage = { type: "subscribe"; agentId: number; after?: number } | { type: "unsubscribe"; agentId: number } | DialogueFrame | PlannerDialogueFrame | AnswerFrame;

// Events pushed to the UI over `/ws`. They announce a change; the client refetches the affected queries.
export type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "transition"; issueNumber: number; from: TaskStage | null; to: TaskStage; reason: string | null; at: string }
  | { type: "task"; issueNumber: number; stage: TaskStage; round: number }
  | { type: "agent"; agentId: number; issueNumber: number | null; role: AgentRole; state: AgentState; previous: AgentState }
  | { type: "request"; requestId: number; issueNumber: number; open: boolean }
  | { type: "installation"; installation: InstallationResponse }
  // One message of a subscribed Agent's feed, in `seq` order.
  | { type: "agent-message"; agentId: number; seq: number; message: SDKMessage }
  // The queue of a Task changed; the panel refetches it.
  | { type: "dialogue"; issueNumber: number; messageId: number; state: "queued" | "delivered" | "removed" }
  // The Planner started, stopped, ended a Turn or its queue changed; the planning screen refetches it.
  | { type: "planner" }
  // Sent only to the socket that sent the frame.
  | AckEvent;

// Planning mode

export type PlannerStatusView = "none" | "running" | "idle" | "stopped";

// A line to the Planner typed during its Turn; it reaches the Session at the end of the Turn.
export type PlannerLineView = { id: number; clientId: string; seq: number; text: string; createdAt: string };

// `GET /api/planner`: the Planner of the open Session, else the last one. `open` is true between start and
// finish; `canResume` says whether "продолжить прошлую" has a Session to continue.
export type PlannerResponse = {
  status: PlannerStatusView;
  open: boolean;
  canResume: boolean;
  agent: AgentView | null;
  sessionId: string | null;
  queue: PlannerLineView[];
};

export type PlannerMode = "resume" | "new";

// `POST /api/planner/start`: a new Session or the last one resumed; `message` is the first line of the human.
export type StartPlannerRequest = { mode: PlannerMode; message?: string };

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
