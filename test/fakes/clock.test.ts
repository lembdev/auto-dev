import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/fakes/clock.js";

describe("FakeClock", () => {
  it("fires timers in order while advancing and resolves sleep", async () => {
    const clock = new FakeClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("b"), 20);
    clock.setTimeout(() => fired.push("a"), 10);
    const slept = clock.sleep(15).then(() => fired.push("sleep"));

    await clock.advance(5);
    expect(fired).toEqual([]);
    await clock.advance(10);
    expect(fired).toEqual(["a", "sleep"]);
    await clock.advance(10);
    await slept;
    expect(fired).toEqual(["a", "sleep", "b"]);
    expect(clock.now()).toBe(25);
  });

  it("repeats intervals until cleared", async () => {
    const clock = new FakeClock(0);
    let ticks = 0;
    const handle = clock.setInterval(() => ticks++, 10);
    await clock.advance(35);
    expect(ticks).toBe(3);
    clock.clear(handle);
    await clock.advance(100);
    expect(ticks).toBe(3);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("lets a callback schedule the next timer within the same advance", async () => {
    const clock = new FakeClock(0);
    const seen: number[] = [];
    const tick = () => {
      seen.push(clock.now());
      if (seen.length < 3) clock.setTimeout(tick, 10);
    };
    clock.setTimeout(tick, 10);
    await clock.advance(100);
    expect(seen).toEqual([10, 20, 30]);
    expect(clock.now()).toBe(100);
  });
});
