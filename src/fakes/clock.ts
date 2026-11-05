import type { Clock, TimerHandle } from "../ports/clock.js";

type Timer = {
  id: TimerHandle;
  at: number;
  callback: () => void;
  interval: number | undefined;
};

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Deterministic clock: time moves only through `advance()` and `set()`.
export class FakeClock implements Clock {
  private _now: number;
  private _nextId = 1;
  private readonly _timers = new Map<TimerHandle, Timer>();

  constructor(start = Date.parse("2026-01-01T00:00:00.000Z")) {
    this._now = start;
  }

  now(): number {
    return this._now;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    return this._schedule(callback, ms, undefined);
  }

  setInterval(callback: () => void, ms: number): TimerHandle {
    return this._schedule(callback, ms, ms);
  }

  clear(handle: TimerHandle): void {
    this._timers.delete(handle);
  }

  pendingTimers(): number {
    return this._timers.size;
  }

  // Moves time forward, firing due timers in order and letting promise chains settle between them.
  async advance(ms: number): Promise<void> {
    const target = this._now + ms;
    for (;;) {
      const next = this._nextDue(target);
      if (!next) break;
      this._now = next.at;
      if (next.interval === undefined) {
        this._timers.delete(next.id);
      } else {
        next.at += next.interval;
      }
      next.callback();
      await flushMicrotasks();
    }
    this._now = target;
    await flushMicrotasks();
  }

  async set(epochMs: number): Promise<void> {
    if (epochMs < this._now) {
      this._now = epochMs;
      await flushMicrotasks();
      return;
    }
    await this.advance(epochMs - this._now);
  }

  private _schedule(callback: () => void, ms: number, interval: number | undefined): TimerHandle {
    const id = this._nextId++ as TimerHandle;
    this._timers.set(id, { id, at: this._now + Math.max(0, ms), callback, interval });
    return id;
  }

  private _nextDue(limit: number): Timer | undefined {
    let best: Timer | undefined;
    for (const timer of this._timers.values()) {
      if (timer.at > limit) continue;
      if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer;
    }
    return best;
  }
}
