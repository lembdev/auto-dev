import type { DatabaseSync } from "node:sqlite";
import type { IntentId, IssueNumber } from "../ids.js";

export type IntentState = "pending" | "done";

// An external action the Orchestrator is about to take (branch, worktree, PR, comment). It is written
// before the action and marked done after, so a crash in between leaves a pending row to finish on restart.
export type Intent = {
  id: IntentId;
  kind: string;
  issueNumber: IssueNumber;
  payload: unknown;
  state: IntentState;
  result: unknown;
  createdAt: string;
  doneAt: string | null;
};

export type NewIntent = {
  kind: string;
  issueNumber: IssueNumber;
  payload: unknown;
};

type IntentRow = {
  id: number;
  kind: string;
  issue_number: number;
  payload: string;
  state: string;
  result: string | null;
  created_at: string;
  done_at: string | null;
};

const COLUMNS = "id, kind, issue_number, payload, state, result, created_at, done_at";

const toIntent = (row: IntentRow): Intent => ({
  id: row.id as IntentId,
  kind: row.kind,
  issueNumber: row.issue_number as IssueNumber,
  payload: JSON.parse(row.payload) as unknown,
  state: row.state as IntentState,
  result: row.result === null ? null : (JSON.parse(row.result) as unknown),
  createdAt: row.created_at,
  doneAt: row.done_at,
});

export class IntentStore {
  constructor(private readonly _db: DatabaseSync) {}

  add(intent: NewIntent, now: string): Intent {
    const result = this._db
      .prepare("INSERT INTO intents (kind, issue_number, payload, state, result, created_at, done_at) VALUES (?, ?, ?, 'pending', NULL, ?, NULL)")
      .run(intent.kind, intent.issueNumber, JSON.stringify(intent.payload), now);
    return {
      id: Number(result.lastInsertRowid) as IntentId,
      kind: intent.kind,
      issueNumber: intent.issueNumber,
      payload: intent.payload,
      state: "pending",
      result: null,
      createdAt: now,
      doneAt: null,
    };
  }

  markDone(id: IntentId, result: unknown, now: string): void {
    this._db
      .prepare("UPDATE intents SET state = 'done', result = ?, done_at = ? WHERE id = ?")
      .run(result === undefined ? null : JSON.stringify(result), now, id);
  }

  find(id: IntentId): Intent | undefined {
    const row = this._db.prepare(`SELECT ${COLUMNS} FROM intents WHERE id = ?`).get(id) as IntentRow | undefined;
    return row ? toIntent(row) : undefined;
  }

  listPending(): Intent[] {
    const rows = this._db.prepare(`SELECT ${COLUMNS} FROM intents WHERE state = 'pending' ORDER BY id`).all() as IntentRow[];
    return rows.map(toIntent);
  }

  listFor(issueNumber: IssueNumber): Intent[] {
    const rows = this._db.prepare(`SELECT ${COLUMNS} FROM intents WHERE issue_number = ? ORDER BY id`).all(issueNumber) as IntentRow[];
    return rows.map(toIntent);
  }

  list(): Intent[] {
    const rows = this._db.prepare(`SELECT ${COLUMNS} FROM intents ORDER BY id`).all() as IntentRow[];
    return rows.map(toIntent);
  }
}
