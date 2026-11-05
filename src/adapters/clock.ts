import type { Clock, TimerHandle } from "../ports/clock.js";

export class SystemClock implements Clock {
  private _nextId = 1;
  private readonly _timers = new Map<TimerHandle, NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const handle = this._nextId++ as TimerHandle;
    this._timers.set(
      handle,
      setTimeout(() => {
        this._timers.delete(handle);
        callback();
      }, ms),
    );
    return handle;
  }

  setInterval(callback: () => void, ms: number): TimerHandle {
    const handle = this._nextId++ as TimerHandle;
    this._timers.set(handle, setInterval(callback, ms));
    return handle;
  }

  clear(handle: TimerHandle): void {
    const timer = this._timers.get(handle);
    if (!timer) return;
    clearTimeout(timer);
    this._timers.delete(handle);
  }
}
