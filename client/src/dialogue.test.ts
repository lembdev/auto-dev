import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AckEvent } from "../../src/server/api-types.js";
import { ACK_TIMEOUT_MS, DialogueOutbox, STORAGE_KEYS, SWEEP_MS, type StorageLike } from "./dialogue.js";

const OPEN = 1;

class FakeSocket {
  readonly sent: Record<string, unknown>[] = [];
  readyState = OPEN;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
}

const memoryStorage = (): StorageLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
};

const ack = (clientId: string, seq: number, outcome: AckEvent["outcome"], watermark = seq, reason: string | null = null): AckEvent => ({
  type: "ack",
  clientId,
  seq,
  watermark,
  outcome,
  reason,
});

describe("the outbox of the Dialogue", () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const outboxOn = (storage: StorageLike | null) => new DialogueOutbox({ storage, now: () => now });

  it("numbers frames from a stored counter, writes them down before sending and sends them once attached", () => {
    const storage = memoryStorage();
    const outbox = outboxOn(storage);
    const socket = new FakeSocket();
    const first = outbox.send({ kind: "dialogue", issueNumber: 7 }, "hello");
    expect(first).toMatchObject({ seq: 1, sentAt: null });
    expect(storage.map.get(STORAGE_KEYS.clientId)).toBe(outbox.clientId);
    expect(storage.map.get(STORAGE_KEYS.seq)).toBe("1");
    expect(JSON.parse(storage.map.get(STORAGE_KEYS.outbox)!)).toEqual([{ kind: "dialogue", issueNumber: 7, seq: 1, text: "hello" }]);

    outbox.attach(socket, () => {});
    outbox.send({ kind: "answer", issueNumber: 7, requestId: 3 }, "blue");
    expect(socket.sent).toEqual([
      { type: "dialogue", clientId: outbox.clientId, seq: 1, issueNumber: 7, text: "hello" },
      { type: "answer", clientId: outbox.clientId, seq: 2, requestId: 3, text: "blue" },
    ]);
    expect(outbox.pending(7).map((frame) => frame.seq)).toEqual([1, 2]);
    expect(outbox.pending(8)).toEqual([]);
  });

  it("removes a frame on its ACK, tells the listeners and raises the counter to the watermark", () => {
    const storage = memoryStorage();
    const outbox = outboxOn(storage);
    const socket = new FakeSocket();
    outbox.attach(socket, () => {});
    const acks: [number, string][] = [];
    outbox.onAck((frame, event) => acks.push([frame.seq, event.outcome]));
    outbox.send({ kind: "dialogue", issueNumber: 7 }, "one");
    outbox.dispatch(ack("someone else", 1, "applied"));
    expect(outbox.pending()).toHaveLength(1);
    outbox.dispatch(ack(outbox.clientId, 1, "applied", 9));
    expect(outbox.pending()).toEqual([]);
    expect(acks).toEqual([[1, "applied"]]);
    expect(storage.map.get(STORAGE_KEYS.seq)).toBe("9");
    expect(outbox.send({ kind: "dialogue", issueNumber: 7 }, "two").seq).toBe(10);
    outbox.dispatch(ack(outbox.clientId, 10, "rejected", 10, "empty text"));
    expect(acks).toEqual([
      [1, "applied"],
      [10, "rejected"],
    ]);
    expect(JSON.parse(storage.map.get(STORAGE_KEYS.outbox)!)).toEqual([]);
  });

  it("keeps the client id, the counter and the unconfirmed frames across a reload and resends them on attach", () => {
    const storage = memoryStorage();
    const before = outboxOn(storage);
    before.send({ kind: "dialogue", issueNumber: 7 }, "lost in flight");
    before.send({ kind: "dialogue", issueNumber: 7 }, "and this one");

    const after = outboxOn(storage);
    expect(after.clientId).toBe(before.clientId);
    expect(after.pending().map((frame) => [frame.seq, frame.text, frame.sentAt])).toEqual([
      [1, "lost in flight", null],
      [2, "and this one", null],
    ]);
    const socket = new FakeSocket();
    after.attach(socket, () => {});
    expect(socket.sent.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(after.send({ kind: "dialogue", issueNumber: 7 }, "third").seq).toBe(3);
  });

  it("forces a reconnect when the oldest frame waits longer than the ACK timeout, then sends everything again", () => {
    const outbox = outboxOn(memoryStorage());
    const socket = new FakeSocket();
    const reconnect = vi.fn();
    outbox.attach(socket, reconnect);
    outbox.send({ kind: "dialogue", issueNumber: 7 }, "one");
    now += ACK_TIMEOUT_MS - 1;
    vi.advanceTimersByTime(SWEEP_MS);
    expect(reconnect).not.toHaveBeenCalled();
    now += 1;
    vi.advanceTimersByTime(SWEEP_MS);
    expect(reconnect).toHaveBeenCalledTimes(1);
    // Until the new socket is attached nothing is sent; the frame stays, unsent.
    outbox.send({ kind: "dialogue", issueNumber: 7 }, "two");
    expect(socket.sent).toHaveLength(1);
    expect(outbox.pending().map((frame) => frame.sentAt)).toEqual([null, null]);

    outbox.detach();
    const fresh = new FakeSocket();
    outbox.attach(fresh, reconnect);
    expect(fresh.sent.map((frame) => [frame.seq, frame.text])).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
    outbox.dispatch(ack(outbox.clientId, 1, "duplicate", 2));
    outbox.dispatch(ack(outbox.clientId, 2, "applied"));
    vi.advanceTimersByTime(SWEEP_MS * 3);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("works without storage: the frames live in memory and the client id is fresh", () => {
    const outbox = outboxOn(null);
    expect(outbox.clientId).not.toBe("");
    expect(outbox.send({ kind: "dialogue", issueNumber: 7 }, "hi").seq).toBe(1);
    expect(outbox.pending()).toHaveLength(1);
  });
});
