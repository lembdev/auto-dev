import type { DatabaseSync } from "node:sqlite";
import type { AgentId, IssueNumber } from "../ids.js";
import type { AgentRole } from "./agents.js";

// What a dead end of one attempt of a Task remembers besides the reason: the Agent the Task was about
// and its last text at that moment, so the human sees why the Agent stopped.
export type DeadEndRecord = {
  issueNumber: IssueNumber;
  attempt: number;
  agentId: AgentId | null;
  agentRole: AgentRole | null;
  lastMessage: string | null;
  at: string;
};

type Row = {
  issue_number: number;
  attempt: number;
  agent_id: number | null;
  agent_role: string | null;
  last_message: string | null;
  at: string;
};

const COLUMNS = "issue_number, attempt, agent_id, agent_role, last_message, at";

const toRecord = (row: Row): DeadEndRecord => ({
  issueNumber: row.issue_number as IssueNumber,
  attempt: row.attempt,
  agentId: row.agent_id as AgentId | null,
  agentRole: row.agent_role as AgentRole | null,
  lastMessage: row.last_message,
  at: row.at,
});

export class DeadEndStore {
  constructor(private readonly _db: DatabaseSync) {}

  // One row per attempt; entering the same dead end again keeps the first record.
  record(entry: DeadEndRecord): void {
    this._db
      .prepare(`INSERT INTO dead_ends (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(issue_number, attempt) DO NOTHING`)
      .run(entry.issueNumber, entry.attempt, entry.agentId, entry.agentRole, entry.lastMessage, entry.at);
  }

  find(issueNumber: IssueNumber, attempt: number): DeadEndRecord | undefined {
    const row = this._db.prepare(`SELECT ${COLUMNS} FROM dead_ends WHERE issue_number = ? AND attempt = ?`).get(issueNumber, attempt) as
      | Row
      | undefined;
    return row ? toRecord(row) : undefined;
  }
}
