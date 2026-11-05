import { readFile, statfs } from "node:fs/promises";
import type { DiskPort, DiskUsage } from "../ports/disk.js";

// Filesystem usage through statfs; the percentage follows `df` (reserved blocks count as used).
export class NodeDiskPort implements DiskPort {
  async usage(path: string): Promise<DiskUsage> {
    const stats = await statfs(path);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
    const visible = usedBytes + freeBytes;
    const usedPercent = visible === 0 ? 0 : Math.round((usedBytes / visible) * 1000) / 10;
    return { totalBytes, freeBytes, usedPercent };
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
