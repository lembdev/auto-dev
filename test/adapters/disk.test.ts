import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeDiskPort } from "../../src/adapters/disk.js";

describe("NodeDiskPort", () => {
  it("reports how full the filesystem of a path is", async () => {
    const usage = await new NodeDiskPort().usage(os.tmpdir());
    expect(usage.usedPercent).toBeGreaterThanOrEqual(0);
    expect(usage.usedPercent).toBeLessThanOrEqual(100);
    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.freeBytes).toBeLessThanOrEqual(usage.totalBytes);
  });

  it("reads a file and answers undefined for a missing one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "auto-dev-disk-"));
    try {
      await writeFile(path.join(dir, "a.json"), "{}", "utf8");
      const disk = new NodeDiskPort();
      expect(await disk.readFile(path.join(dir, "a.json"))).toBe("{}");
      expect(await disk.readFile(path.join(dir, "missing.json"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
