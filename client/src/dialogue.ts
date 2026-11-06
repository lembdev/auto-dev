import { useEffect, useState } from "react";
import type { AckEvent, AnswerFrame, DialogueFrame, PlannerDialogueFrame, ServerEvent } from "../../src/server/api-types.js";

// Where a frame goes: a line of the Dialogue of a Task, the Answer of its open Request, or a line to the Planner.
export type OutboxTarget = { kind: "dialogue"; issueNumber: number } | { kind: "answer"; issueNumber: number; requestId: number } | { kind: "planner" };

// Which chat a frame belongs to: a Task by its issue number, or the planning chat.
export type OutboxChat = number | "planner";

export const chatOf = (target: OutboxTarget): OutboxChat => (target.kind === "planner" ? "planner" : target.issueNumber);

// A frame written down before it is sent and kept until the server confirms it.
export type OutboxFrame = OutboxTarget & { seq: number; text: string; sentAt: number | null };

export type AckListener = (frame: OutboxFrame, ack: AckEvent) => void;

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

type SocketLike = { readyState: number; send(data: string): void };

export const STORAGE_KEYS = {
  clientId: "auto-dev.dialogue.clientId",
  seq: "auto-dev.dialogue.seq",
  outbox: "auto-dev.dialogue.outbox",
} as const;

// A frame older than this without its ACK means the socket is dead, whatever the browser thinks.
export const ACK_TIMEOUT_MS = 4_000;
export const SWEEP_MS = 2_000;

const OPEN = 1;

export type DialogueOutboxOptions = {
  // null runs without persistence (a private window with storage blocked).
  storage?: StorageLike | null;
  now?: () => number;
};

const browserStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const newClientId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const isFrame = (raw: unknown): raw is OutboxFrame => {
  if (typeof raw !== "object" || raw === null) return false;
  const frame = raw as Record<string, unknown>;
  if (typeof frame.seq !== "number" || typeof frame.text !== "string") return false;
  if (frame.kind === "planner") return true;
  return typeof frame.issueNumber === "number" && (frame.kind === "dialogue" || (frame.kind === "answer" && typeof frame.requestId === "number"));
};

// The outbox of the tab: every frame is stored before it is sent and removed only by the server's
// ACK, so a dead socket loses nothing and a repeat after a reconnect is confirmed, not applied twice.
// `clientId` names the browser for good; `seq` only grows, across reloads, and jumps up to the
// watermark the server reports.
export class DialogueOutbox {
  readonly clientId: string;
  private readonly _storage: StorageLike | null;
  private readonly _now: () => number;
  private _frames: OutboxFrame[];
  private _seq: number;
  private _socket: SocketLike | undefined;
  private _reconnect: (() => void) | undefined;
  private _sweeper: ReturnType<typeof setInterval> | undefined;
  private readonly _ackListeners = new Set<AckListener>();
  private readonly _changeListeners = new Set<() => void>();

  constructor(options: DialogueOutboxOptions = {}) {
    this._storage = options.storage === undefined ? browserStorage() : options.storage;
    this._now = options.now ?? (() => Date.now());
    const storedId = this._read(STORAGE_KEYS.clientId);
    this.clientId = storedId ?? newClientId();
    if (storedId === null) this._write(STORAGE_KEYS.clientId, this.clientId);
    this._seq = this._storedSeq();
    this._frames = this._storedFrames();
  }

  // The socket is open: everything still unconfirmed goes out again, and the sweep watches for a dead socket.
  attach(socket: SocketLike, reconnect: () => void): void {
    this._socket = socket;
    this._reconnect = reconnect;
    for (const frame of this._frames) this._transmit(frame);
    this._notifyChange();
    if (this._sweeper === undefined) this._sweeper = setInterval(() => this.sweep(), SWEEP_MS);
  }

  detach(): void {
    this._socket = undefined;
    if (this._sweeper !== undefined) {
      clearInterval(this._sweeper);
      this._sweeper = undefined;
    }
    for (const frame of this._frames) frame.sentAt = null;
    this._notifyChange();
  }

  send(target: OutboxTarget, text: string): OutboxFrame {
    const frame: OutboxFrame = { ...target, seq: this._nextSeq(), text, sentAt: null };
    this._frames.push(frame);
    this._persist();
    this._transmit(frame);
    this._notifyChange();
    return frame;
  }

  // Frames of the tab the server has not confirmed; of one chat when `chat` is given.
  pending(chat?: OutboxChat): OutboxFrame[] {
    return this._frames.filter((frame) => chat === undefined || chatOf(frame) === chat).map((frame) => ({ ...frame }));
  }

  // The server's answer to one frame; other events are not its business.
  dispatch(event: ServerEvent): void {
    if (event.type !== "ack" || event.clientId !== this.clientId) return;
    if (event.watermark > this._seq) {
      this._seq = event.watermark;
      this._write(STORAGE_KEYS.seq, String(this._seq));
    }
    const index = this._frames.findIndex((frame) => frame.seq === event.seq);
    if (index < 0) return;
    const [frame] = this._frames.splice(index, 1);
    this._persist();
    for (const listener of this._ackListeners) listener(frame!, event);
    this._notifyChange();
  }

  // Every two seconds: a frame unconfirmed for too long forces a reconnect, which resends everything.
  sweep(): void {
    if (!this._socket) return;
    const oldest = this._frames.find((frame) => frame.sentAt !== null);
    if (!oldest || this._now() - oldest.sentAt! < ACK_TIMEOUT_MS) return;
    for (const frame of this._frames) frame.sentAt = null;
    this._socket = undefined;
    this._reconnect?.();
  }

  onAck(listener: AckListener): () => void {
    this._ackListeners.add(listener);
    return () => this._ackListeners.delete(listener);
  }

  onChange(listener: () => void): () => void {
    this._changeListeners.add(listener);
    return () => this._changeListeners.delete(listener);
  }

  private _transmit(frame: OutboxFrame): void {
    if (!this._socket || this._socket.readyState !== OPEN) return;
    const wire: DialogueFrame | PlannerDialogueFrame | AnswerFrame =
      frame.kind === "dialogue"
        ? { type: "dialogue", clientId: this.clientId, seq: frame.seq, issueNumber: frame.issueNumber, text: frame.text }
        : frame.kind === "planner"
          ? { type: "dialogue", to: "planner", clientId: this.clientId, seq: frame.seq, text: frame.text }
          : { type: "answer", clientId: this.clientId, seq: frame.seq, requestId: frame.requestId, text: frame.text };
    try {
      this._socket.send(JSON.stringify(wire));
      frame.sentAt = this._now();
    } catch {
      // The sweep notices the frame without an ACK and reconnects.
    }
  }

  // Another tab of the same browser may have moved the counter: the stored value wins over memory.
  private _nextSeq(): number {
    this._seq = Math.max(this._seq, this._storedSeq()) + 1;
    this._write(STORAGE_KEYS.seq, String(this._seq));
    return this._seq;
  }

  private _storedSeq(): number {
    const parsed = Number(this._read(STORAGE_KEYS.seq));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  private _storedFrames(): OutboxFrame[] {
    const raw = this._read(STORAGE_KEYS.outbox);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isFrame).map((frame) => ({ ...frame, sentAt: null })) : [];
    } catch {
      return [];
    }
  }

  private _persist(): void {
    this._write(STORAGE_KEYS.outbox, JSON.stringify(this._frames.map(({ sentAt: _sentAt, ...frame }) => frame)));
  }

  private _read(key: string): string | null {
    try {
      return this._storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private _write(key: string, value: string): void {
    try {
      this._storage?.setItem(key, value);
    } catch {
      // Storage blocked: the outbox lives in memory for this tab.
    }
  }

  private _notifyChange(): void {
    for (const listener of this._changeListeners) listener();
  }
}

export const dialogueOutbox = new DialogueOutbox();

export type LastAck = { frame: OutboxFrame; ack: AckEvent };

export type DialogueOutboxHook = {
  pending: OutboxFrame[];
  lastAck: LastAck | null;
  send(target: OutboxTarget, text: string): void;
};

// The outbox as one chat sees it (the panel of a Task or the planning screen): its unconfirmed frames
// and the last ACK of one of them.
export function useDialogueOutbox(chat: OutboxChat, outbox: DialogueOutbox = dialogueOutbox): DialogueOutboxHook {
  const [pending, setPending] = useState<OutboxFrame[]>(() => outbox.pending(chat));
  const [lastAck, setLastAck] = useState<LastAck | null>(null);

  useEffect(() => {
    setPending(outbox.pending(chat));
    setLastAck(null);
    const unsubscribeChange = outbox.onChange(() => setPending(outbox.pending(chat)));
    const unsubscribeAck = outbox.onAck((frame, ack) => {
      if (chatOf(frame) === chat) setLastAck({ frame, ack });
    });
    return () => {
      unsubscribeChange();
      unsubscribeAck();
    };
  }, [chat, outbox]);

  return { pending, lastAck, send: (target, text) => outbox.send(target, text) };
}
