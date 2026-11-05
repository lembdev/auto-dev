export type TimerHandle = number & { __brand: "TimerHandle" };

// All time in the Orchestrator goes through this port so tests can drive it.
export interface Clock {
  // Milliseconds since the Unix epoch.
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  setInterval(callback: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}
