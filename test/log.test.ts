import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { createLogSink } from "./helpers/test-app.js";

describe("logger", () => {
  it("writes JSON lines and filters by the configured level", async () => {
    const sink = createLogSink();
    const log = createLogger({ level: "warn", destination: sink });
    log.info({ issue: 1 }, "hidden");
    log.warn({ issue: 2 }, "shown");
    log.flush?.();
    await new Promise((resolve) => setImmediate(resolve));

    const lines = sink.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, app: "auto-dev", issue: 2, msg: "shown" });
  });
});
