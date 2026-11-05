import type { DatabaseSync } from "node:sqlite";
import type { IssueNumber, MilestoneNumber, PullNumber } from "../ids.js";
import type { MilestoneRef } from "../ports/github.js";

// Pipeline position of a Task. The Stage itself lives only here and in the UI, never in GitHub labels.
export type TaskStage = "taken" | "implement" | "qa" | "merge" | "done" | "stuck" | "cancelled";

// Stages in which the Task is still being worked on and therefore excluded from the Ready queue.
export const ACTIVE_STAGES: readonly TaskStage[] = ["taken", "implement", "qa", "merge"];

export const isActiveStage = (stage: TaskStage): boolean => ACTIVE_STAGES.includes(stage);

export type Task = {
  issueNumber: IssueNumber;
  title: string;
  milestone: MilestoneRef | null;
  stage: TaskStage;
  round: number;
  // Counts how many times the Task was taken; a return from a dead end starts a new attempt.
  attempt: number;
  pullNumber: PullNumber | null;
  branch: string | null;
  worktreePath: string | null;
  takenAt: string;
  updatedAt: string;
};

export type NewTask = Omit<Task, "round" | "attempt" | "pullNumber" | "branch" | "worktreePath" | "updatedAt"> &
  Partial<Pick<Task, "round" | "attempt" | "pullNumber" | "branch" | "worktreePath">>;

export type TaskPatch = Partial<Omit<Task, "issueNumber" | "takenAt" | "updatedAt">>;

export type Transition = {
  id: number;
  issueNumber: IssueNumber;
  from: TaskStage | null;
  to: TaskStage;
  reason: string | null;
  at: string;
};

export class TaskNotFoundError extends Error {
  constructor(readonly issueNumber: IssueNumber) {
    super(`task for issue #${issueNumber} not found in the runtime index`);
    this.name = "TaskNotFoundError";
  }
}

type TaskRow = {
  issue_number: number;
  title: string;
  milestone_number: number | null;
  milestone_title: string | null;
  stage: string;
  round: number;
  attempt: number;
  pull_number: number | null;
  branch: string | null;
  worktree_path: string | null;
  taken_at: string;
  updated_at: string;
};

const toTask = (row: TaskRow): Task => ({
  issueNumber: row.issue_number as IssueNumber,
  title: row.title,
  milestone:
    row.milestone_number === null
      ? null
      : { number: row.milestone_number as MilestoneNumber, title: row.milestone_title ?? "" },
  stage: row.stage as TaskStage,
  round: row.round,
  attempt: row.attempt,
  pullNumber: row.pull_number === null ? null : (row.pull_number as PullNumber),
  branch: row.branch,
  worktreePath: row.worktree_path,
  takenAt: row.taken_at,
  updatedAt: row.updated_at,
});

const TASK_COLUMNS =
  "issue_number, title, milestone_number, milestone_title, stage, round, attempt, pull_number, branch, worktree_path, taken_at, updated_at";

// One row per Task: what the Orchestrator knows about an issue it has taken.
export class TaskStore {
  constructor(private readonly _db: DatabaseSync) {}

  insert(task: NewTask, now: string): Task {
    const full: Task = {
      round: 0,
      attempt: 1,
      pullNumber: null,
      branch: null,
      worktreePath: null,
      ...task,
      updatedAt: now,
    };
    this._db
      .prepare(`INSERT INTO tasks (${TASK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        full.issueNumber,
        full.title,
        full.milestone?.number ?? null,
        full.milestone?.title ?? null,
        full.stage,
        full.round,
        full.attempt,
        full.pullNumber,
        full.branch,
        full.worktreePath,
        full.takenAt,
        full.updatedAt,
      );
    return full;
  }

  find(issueNumber: IssueNumber): Task | undefined {
    const row = this._db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE issue_number = ?`).get(issueNumber) as
      | TaskRow
      | undefined;
    return row ? toTask(row) : undefined;
  }

  get(issueNumber: IssueNumber): Task {
    const task = this.find(issueNumber);
    if (!task) throw new TaskNotFoundError(issueNumber);
    return task;
  }

  list(): Task[] {
    const rows = this._db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY taken_at, issue_number`).all() as TaskRow[];
    return rows.map(toTask);
  }

  listByStage(stages: readonly TaskStage[]): Task[] {
    return this.list().filter((task) => stages.includes(task.stage));
  }

  listActive(): Task[] {
    return this.listByStage(ACTIVE_STAGES);
  }

  update(issueNumber: IssueNumber, patch: TaskPatch, now: string): Task {
    const current = this.get(issueNumber);
    const next: Task = { ...current, ...patch, updatedAt: now };
    this._db
      .prepare(
        `UPDATE tasks SET title = ?, milestone_number = ?, milestone_title = ?, stage = ?, round = ?, attempt = ?,
           pull_number = ?, branch = ?, worktree_path = ?, updated_at = ?
         WHERE issue_number = ?`,
      )
      .run(
        next.title,
        next.milestone?.number ?? null,
        next.milestone?.title ?? null,
        next.stage,
        next.round,
        next.attempt,
        next.pullNumber,
        next.branch,
        next.worktreePath,
        next.updatedAt,
        issueNumber,
      );
    return next;
  }

  delete(issueNumber: IssueNumber): void {
    this._db.prepare("DELETE FROM tasks WHERE issue_number = ?").run(issueNumber);
  }
}

type TransitionRow = {
  id: number;
  issue_number: number;
  from_stage: string | null;
  to_stage: string;
  reason: string | null;
  at: string;
};

const toTransition = (row: TransitionRow): Transition => ({
  id: row.id,
  issueNumber: row.issue_number as IssueNumber,
  from: row.from_stage as TaskStage | null,
  to: row.to_stage as TaskStage,
  reason: row.reason,
  at: row.at,
});

// Append-only history of Stage changes; statistics and notifications are built on it.
export class TransitionStore {
  constructor(private readonly _db: DatabaseSync) {}

  append(entry: Omit<Transition, "id">): Transition {
    const result = this._db
      .prepare("INSERT INTO transitions (issue_number, from_stage, to_stage, reason, at) VALUES (?, ?, ?, ?, ?)")
      .run(entry.issueNumber, entry.from, entry.to, entry.reason, entry.at);
    return { id: Number(result.lastInsertRowid), ...entry };
  }

  listFor(issueNumber: IssueNumber): Transition[] {
    const rows = this._db
      .prepare("SELECT id, issue_number, from_stage, to_stage, reason, at FROM transitions WHERE issue_number = ? ORDER BY id")
      .all(issueNumber) as TransitionRow[];
    return rows.map(toTransition);
  }

  list(): Transition[] {
    const rows = this._db
      .prepare("SELECT id, issue_number, from_stage, to_stage, reason, at FROM transitions ORDER BY id")
      .all() as TransitionRow[];
    return rows.map(toTransition);
  }
}
