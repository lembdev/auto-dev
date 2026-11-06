import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentId } from "../ids.js";

// One message of an Agent as the UI feed sees it: `seq` grows by one per message of the Agent for
// the life of the Orchestrator, across process restarts of the same Session.
export type FeedEntry = { seq: number; message: SDKMessage };

export type FeedListener = (agentId: AgentId, entry: FeedEntry) => void;

// How many recent messages per Agent stay in memory for late subscribers; a long Turn streams
// thousands of deltas, so the tail must be long enough to cover the latency of a history read.
export const DEFAULT_FEED_LIMIT = 4000;

type Buffer = { nextSeq: number; entries: FeedEntry[] };

const uuidOf = (message: SDKMessage): string | undefined =>
  "uuid" in message && typeof message.uuid === "string" ? message.uuid : undefined;

// In-memory tail of every Agent's message stream with monotonic sequence numbers. The panel reads
// the Session history from disk, then subscribes from the seam `cursorFor` computes, so nothing
// is shown twice and nothing emitted in between is lost.
export class AgentFeed {
  private readonly _buffers = new Map<AgentId, Buffer>();
  private readonly _listeners = new Map<AgentId, Set<FeedListener>>();

  constructor(private readonly _limit = DEFAULT_FEED_LIMIT) {}

  push(agentId: AgentId, message: SDKMessage): FeedEntry {
    let buffer = this._buffers.get(agentId);
    if (!buffer) {
      buffer = { nextSeq: 1, entries: [] };
      this._buffers.set(agentId, buffer);
    }
    const entry: FeedEntry = { seq: buffer.nextSeq, message };
    buffer.nextSeq += 1;
    buffer.entries.push(entry);
    if (buffer.entries.length > this._limit) buffer.entries.splice(0, buffer.entries.length - this._limit);
    for (const listener of this._listeners.get(agentId) ?? []) listener(agentId, entry);
    return entry;
  }

  lastSeq(agentId: AgentId): number {
    return (this._buffers.get(agentId)?.nextSeq ?? 1) - 1;
  }

  // Buffered entries newer than `seq`, oldest first.
  after(agentId: AgentId, seq: number): FeedEntry[] {
    return (this._buffers.get(agentId)?.entries ?? []).filter((entry) => entry.seq > seq);
  }

  // The last buffered message that the history already contains; everything after it is the live
  // tail the history read did not see. Without a common message the whole buffer is the tail.
  cursorFor(agentId: AgentId, history: SDKMessage[]): number {
    const entries = this._buffers.get(agentId)?.entries ?? [];
    const first = entries[0];
    if (!first) return 0;
    const known = new Set(history.map(uuidOf).filter((uuid): uuid is string => uuid !== undefined));
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as FeedEntry;
      const uuid = uuidOf(entry.message);
      if (uuid !== undefined && known.has(uuid)) return entry.seq;
    }
    return first.seq - 1;
  }

  subscribe(agentId: AgentId, listener: FeedListener): () => void {
    let listeners = this._listeners.get(agentId);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(agentId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this._listeners.delete(agentId);
    };
  }
}
