import type { DatabaseSync } from "node:sqlite";
import type { AgentId, IssueNumber, Pid, SessionId } from "../ids.js";

export const AGENT_ROLES = ["implementer", "qa", "merger", "planner"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// Process state of an Agent: running a Turn, idle after one, waiting for a human, or without a process.
export const AGENT_STATES = ["running", "idle", "waiting", "stopped"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export type AgentRecord = {
  id: AgentId;
  // Absent for the Planner, which works outside Tasks.
  issueNumber: IssueNumber | null;
  role: AgentRole;
  cwd: string;
  sessionId: SessionId | null;
  state: AgentState;
  pid: Pid | null;
  // ISO timestamp of the last finished Turn.
  lastTurnAt: string | null;
  createdAt: string;
};

export type NewAgent = {
  issueNumber?: IssueNumber;
  role: AgentRole;
  cwd: string;
  createdAt: string;
};

export type AgentPatch = Partial<Pick<AgentRecord, "sessionId" | "state" | "pid" | "lastTurnAt" | "cwd">>;

export class AgentNotFoundError extends Error {
  constructor(readonly id: AgentId) {
    super(`agent ${id} not found`);
    this.name = "AgentNotFoundError";
  }
}

type Row = {
  id: number;
  issue_number: number | null;
  role: string;
  cwd: string;
  session_id: string | null;
  state: string;
  pid: number | null;
  last_turn_at: string | null;
  created_at: string;
};

const toRecord = (row: Row): AgentRecord => ({
  id: row.id as AgentId,
  issueNumber: row.issue_number as IssueNumber | null,
  role: row.role as AgentRole,
  cwd: row.cwd,
  sessionId: row.session_id as SessionId | null,
  state: row.state as AgentState,
  pid: row.pid as Pid | null,
  lastTurnAt: row.last_turn_at,
  createdAt: row.created_at,
});

const COLUMNS: Record<keyof AgentPatch, string> = {
  sessionId: "session_id",
  state: "state",
  pid: "pid",
  lastTurnAt: "last_turn_at",
  cwd: "cwd",
};

// Agents of the Installation: which Session belongs to which Task and what its process is doing.
export class AgentStore {
  constructor(private readonly _db: DatabaseSync) {}

  create(agent: NewAgent): AgentRecord {
    const result = this._db
      .prepare("INSERT INTO agents (issue_number, role, cwd, state, created_at) VALUES (?, ?, ?, 'stopped', ?)")
      .run(agent.issueNumber ?? null, agent.role, agent.cwd, agent.createdAt);
    return this.get(Number(result.lastInsertRowid) as AgentId);
  }

  find(id: AgentId): AgentRecord | undefined {
    const row = this._db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  get(id: AgentId): AgentRecord {
    const record = this.find(id);
    if (!record) throw new AgentNotFoundError(id);
    return record;
  }

  findBySession(sessionId: SessionId): AgentRecord | undefined {
    const row = this._db.prepare("SELECT * FROM agents WHERE session_id = ?").get(sessionId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(): AgentRecord[] {
    return (this._db.prepare("SELECT * FROM agents ORDER BY id").all() as Row[]).map(toRecord);
  }

  listByIssue(issueNumber: IssueNumber): AgentRecord[] {
    return (this._db.prepare("SELECT * FROM agents WHERE issue_number = ? ORDER BY id").all(issueNumber) as Row[]).map(toRecord);
  }

  update(id: AgentId, patch: AgentPatch): AgentRecord {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof AgentPatch, string | number | null][];
    if (entries.length > 0) {
      const assignments = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(", ");
      const result = this._db.prepare(`UPDATE agents SET ${assignments} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
      if (result.changes === 0) throw new AgentNotFoundError(id);
    }
    return this.get(id);
  }

  delete(id: AgentId): void {
    this._db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }
}
