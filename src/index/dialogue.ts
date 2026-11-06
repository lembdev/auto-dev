import type { DatabaseSync } from "node:sqlite";
import type { AgentId, HumanRequestId, IssueNumber, PendingMessageId } from "../ids.js";
import { Listeners } from "./listeners.js";

// A message of the human on its way to a Session: a line of the Dialogue, or an Answer from the UI
// while `requestId` is set. The row outlives the process, so a restart delivers it; `deliveredAt`
// marks the moment it reached the Session.
export type PendingMessage = {
  id: PendingMessageId;
  issueNumber: IssueNumber;
  // The Agent the human wrote to; null when the Task had none at the time.
  agentId: AgentId | null;
  // The Request this message answers; null for a line of the Dialogue.
  requestId: HumanRequestId | null;
  clientId: string;
  seq: number;
  text: string;
  createdAt: string;
  deliveredAt: string | null;
};

export type NewPendingMessage = Omit<PendingMessage, "id" | "deliveredAt">;

export type PendingMessageChange = { kind: "queued" | "delivered" | "removed"; message: PendingMessage };

export class PendingMessageNotFoundError extends Error {
  constructor(readonly id: PendingMessageId) {
    super(`pending message ${id} not found`);
    this.name = "PendingMessageNotFoundError";
  }
}

type Row = {
  id: number;
  issue_number: number;
  agent_id: number | null;
  request_id: number | null;
  client_id: string;
  seq: number;
  text: string;
  created_at: string;
  delivered_at: string | null;
};

const COLUMNS = "id, issue_number, agent_id, request_id, client_id, seq, text, created_at, delivered_at";

const toMessage = (row: Row): PendingMessage => ({
  id: row.id as PendingMessageId,
  issueNumber: row.issue_number as IssueNumber,
  agentId: row.agent_id as AgentId | null,
  requestId: row.request_id as HumanRequestId | null,
  clientId: row.client_id,
  seq: row.seq,
  text: row.text,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
});

// The queue of the Dialogue and the per-client watermark that makes every frame count once: a frame
// whose `seq` is at or below the watermark of its client was already seen, whatever became of it.
export class DialogueStore {
  private readonly _changes = new Listeners<PendingMessageChange>();

  constructor(private readonly _db: DatabaseSync) {}

  onChange(listener: (change: PendingMessageChange) => void): () => void {
    return this._changes.add(listener);
  }

  watermark(clientId: string): number {
    const row = this._db.prepare("SELECT watermark FROM dialogue_clients WHERE client_id = ?").get(clientId) as { watermark: number } | undefined;
    return row?.watermark ?? 0;
  }

  // Moves the watermark of the client up to `seq`; it never goes down.
  advance(clientId: string, seq: number): void {
    this._db
      .prepare(
        "INSERT INTO dialogue_clients (client_id, watermark) VALUES (?, ?) ON CONFLICT(client_id) DO UPDATE SET watermark = MAX(watermark, excluded.watermark)",
      )
      .run(clientId, seq);
  }

  enqueue(message: NewPendingMessage): PendingMessage {
    const result = this._db
      .prepare(
        "INSERT INTO pending_messages (issue_number, agent_id, request_id, client_id, seq, text, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(message.issueNumber, message.agentId, message.requestId, message.clientId, message.seq, message.text, message.createdAt);
    const created = this.get(Number(result.lastInsertRowid) as PendingMessageId);
    this._changes.emit({ kind: "queued", message: created });
    return created;
  }

  find(id: PendingMessageId): PendingMessage | undefined {
    const row = this._db.prepare(`SELECT ${COLUMNS} FROM pending_messages WHERE id = ?`).get(id) as Row | undefined;
    return row ? toMessage(row) : undefined;
  }

  get(id: PendingMessageId): PendingMessage {
    const message = this.find(id);
    if (!message) throw new PendingMessageNotFoundError(id);
    return message;
  }

  // Lines of the Dialogue not yet in a Session, oldest first; of one Task when `issueNumber` is given.
  listUndelivered(issueNumber?: IssueNumber): PendingMessage[] {
    const rows = (
      issueNumber === undefined
        ? this._db.prepare(`SELECT ${COLUMNS} FROM pending_messages WHERE delivered_at IS NULL AND request_id IS NULL ORDER BY id`).all()
        : this._db.prepare(`SELECT ${COLUMNS} FROM pending_messages WHERE delivered_at IS NULL AND request_id IS NULL AND issue_number = ? ORDER BY id`).all(issueNumber)
    ) as Row[];
    return rows.map(toMessage);
  }

  // Answers from the UI whose Request has not taken them yet.
  listUndeliveredAnswers(): PendingMessage[] {
    const rows = this._db.prepare(`SELECT ${COLUMNS} FROM pending_messages WHERE delivered_at IS NULL AND request_id IS NOT NULL ORDER BY id`).all() as Row[];
    return rows.map(toMessage);
  }

  markDelivered(id: PendingMessageId, at: string): PendingMessage {
    const result = this._db.prepare("UPDATE pending_messages SET delivered_at = ? WHERE id = ?").run(at, id);
    if (result.changes === 0) throw new PendingMessageNotFoundError(id);
    const updated = this.get(id);
    this._changes.emit({ kind: "delivered", message: updated });
    return updated;
  }

  // An Answer that lost the race becomes a line of the Dialogue.
  detachRequest(id: PendingMessageId): PendingMessage {
    const result = this._db.prepare("UPDATE pending_messages SET request_id = NULL WHERE id = ?").run(id);
    if (result.changes === 0) throw new PendingMessageNotFoundError(id);
    const updated = this.get(id);
    this._changes.emit({ kind: "queued", message: updated });
    return updated;
  }

  remove(id: PendingMessageId): void {
    const message = this.get(id);
    this._db.prepare("DELETE FROM pending_messages WHERE id = ?").run(id);
    this._changes.emit({ kind: "removed", message });
  }
}
