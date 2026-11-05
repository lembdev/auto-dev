import type { DatabaseSync } from "node:sqlite";
import type { AgentId, AppliedAnswerId, CommentId, HumanRequestId, IssueNumber } from "../ids.js";

// An open or answered question of an Agent: which call of ask_human in which Session, and where the
// Request comment is. The texts of the question and the Answer are not stored; GitHub holds them.
export type HumanRequest = {
  id: HumanRequestId;
  agentId: AgentId;
  issueNumber: IssueNumber;
  toolUseId: string;
  // The Request comment in the issue; null until it is posted.
  commentId: CommentId | null;
  createdAt: string;
  // Set once the Answer reached the Session as the result of the tool call.
  answeredAt: string | null;
};

export type NewHumanRequest = Pick<HumanRequest, "agentId" | "issueNumber" | "toolUseId" | "createdAt">;

export type HumanRequestPatch = Partial<Pick<HumanRequest, "commentId" | "answeredAt">>;

// Where an Answer came from. A GitHub comment is identified by its id, a message from the UI by its
// client id and sequence number; both are flattened to `kind` + `id` so every channel dedups the same way.
export type AnswerSourceKind = "github" | "ui";

export type AnswerIdentity = { kind: AnswerSourceKind; id: string };

export const githubAnswerIdentity = (commentId: CommentId): AnswerIdentity => ({ kind: "github", id: String(commentId) });

export const uiAnswerIdentity = (clientId: string, seq: number): AnswerIdentity => ({ kind: "ui", id: `${clientId}:${seq}` });

export type AppliedAnswer = {
  id: AppliedAnswerId;
  requestId: HumanRequestId;
  source: AnswerIdentity;
  appliedAt: string;
};

export class HumanRequestNotFoundError extends Error {
  constructor(readonly id: HumanRequestId) {
    super(`human request ${id} not found`);
    this.name = "HumanRequestNotFoundError";
  }
}

type RequestRow = {
  id: number;
  agent_id: number;
  issue_number: number;
  tool_use_id: string;
  comment_id: number | null;
  created_at: string;
  answered_at: string | null;
};

type AnswerRow = {
  id: number;
  request_id: number;
  source_kind: string;
  source_id: string;
  applied_at: string;
};

const REQUEST_COLUMNS = "id, agent_id, issue_number, tool_use_id, comment_id, created_at, answered_at";
const ANSWER_COLUMNS = "id, request_id, source_kind, source_id, applied_at";

const toRequest = (row: RequestRow): HumanRequest => ({
  id: row.id as HumanRequestId,
  agentId: row.agent_id as AgentId,
  issueNumber: row.issue_number as IssueNumber,
  toolUseId: row.tool_use_id,
  commentId: row.comment_id as CommentId | null,
  createdAt: row.created_at,
  answeredAt: row.answered_at,
});

const toAnswer = (row: AnswerRow): AppliedAnswer => ({
  id: row.id as AppliedAnswerId,
  requestId: row.request_id as HumanRequestId,
  source: { kind: row.source_kind as AnswerSourceKind, id: row.source_id },
  appliedAt: row.applied_at,
});

const PATCH_COLUMNS: Record<keyof HumanRequestPatch, string> = { commentId: "comment_id", answeredAt: "answered_at" };

export class HumanRequestStore {
  constructor(private readonly _db: DatabaseSync) {}

  create(request: NewHumanRequest): HumanRequest {
    const result = this._db
      .prepare("INSERT INTO human_requests (agent_id, issue_number, tool_use_id, comment_id, created_at, answered_at) VALUES (?, ?, ?, NULL, ?, NULL)")
      .run(request.agentId, request.issueNumber, request.toolUseId, request.createdAt);
    return this.get(Number(result.lastInsertRowid) as HumanRequestId);
  }

  find(id: HumanRequestId): HumanRequest | undefined {
    const row = this._db.prepare(`SELECT ${REQUEST_COLUMNS} FROM human_requests WHERE id = ?`).get(id) as RequestRow | undefined;
    return row ? toRequest(row) : undefined;
  }

  get(id: HumanRequestId): HumanRequest {
    const request = this.find(id);
    if (!request) throw new HumanRequestNotFoundError(id);
    return request;
  }

  findByToolUse(toolUseId: string): HumanRequest | undefined {
    const row = this._db.prepare(`SELECT ${REQUEST_COLUMNS} FROM human_requests WHERE tool_use_id = ?`).get(toolUseId) as RequestRow | undefined;
    return row ? toRequest(row) : undefined;
  }

  // Requests without an applied Answer, oldest first.
  listOpen(): HumanRequest[] {
    const rows = this._db.prepare(`SELECT ${REQUEST_COLUMNS} FROM human_requests WHERE answered_at IS NULL ORDER BY id`).all() as RequestRow[];
    return rows.map(toRequest);
  }

  listByIssue(issueNumber: IssueNumber): HumanRequest[] {
    const rows = this._db.prepare(`SELECT ${REQUEST_COLUMNS} FROM human_requests WHERE issue_number = ? ORDER BY id`).all(issueNumber) as RequestRow[];
    return rows.map(toRequest);
  }

  update(id: HumanRequestId, patch: HumanRequestPatch): HumanRequest {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof HumanRequestPatch, string | number | null][];
    if (entries.length > 0) {
      const assignments = entries.map(([key]) => `${PATCH_COLUMNS[key]} = ?`).join(", ");
      const result = this._db.prepare(`UPDATE human_requests SET ${assignments} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
      if (result.changes === 0) throw new HumanRequestNotFoundError(id);
    }
    return this.get(id);
  }
}

// Answers that reached a Session, by the identity of their source: the second delivery of the same
// comment or UI message finds its row here and is skipped.
export class AppliedAnswerStore {
  constructor(private readonly _db: DatabaseSync) {}

  add(answer: { requestId: HumanRequestId; source: AnswerIdentity; appliedAt: string }): AppliedAnswer {
    const result = this._db
      .prepare("INSERT INTO applied_answers (request_id, source_kind, source_id, applied_at) VALUES (?, ?, ?, ?)")
      .run(answer.requestId, answer.source.kind, answer.source.id, answer.appliedAt);
    return {
      id: Number(result.lastInsertRowid) as AppliedAnswerId,
      requestId: answer.requestId,
      source: answer.source,
      appliedAt: answer.appliedAt,
    };
  }

  find(source: AnswerIdentity): AppliedAnswer | undefined {
    const row = this._db
      .prepare(`SELECT ${ANSWER_COLUMNS} FROM applied_answers WHERE source_kind = ? AND source_id = ?`)
      .get(source.kind, source.id) as AnswerRow | undefined;
    return row ? toAnswer(row) : undefined;
  }

  listFor(requestId: HumanRequestId): AppliedAnswer[] {
    const rows = this._db.prepare(`SELECT ${ANSWER_COLUMNS} FROM applied_answers WHERE request_id = ? ORDER BY id`).all(requestId) as AnswerRow[];
    return rows.map(toAnswer);
  }
}
