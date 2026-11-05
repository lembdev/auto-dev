import type { DiskPort, DiskUsage } from "../ports/disk.js";
import { CallLog } from "./call-log.js";

const GIB = 1024 ** 3;

// Scripted disk: tests set how full a path is and which files exist.
export class FakeDiskPort implements DiskPort {
  readonly log = new CallLog();
  readonly files = new Map<string, string>();
  private readonly _usages = new Map<string, number>();
  private _defaultUsedPercent = 10;

  get calls() {
    return this.log.calls;
  }

  setUsage(path: string, usedPercent: number): void {
    this._usages.set(path, usedPercent);
  }

  setDefaultUsage(usedPercent: number): void {
    this._defaultUsedPercent = usedPercent;
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  async usage(path: string): Promise<DiskUsage> {
    this.log.record("usage", path);
    const usedPercent = this._usages.get(path) ?? this._defaultUsedPercent;
    const totalBytes = 100 * GIB;
    return { totalBytes, freeBytes: Math.round(((100 - usedPercent) / 100) * totalBytes), usedPercent };
  }

  async readFile(path: string): Promise<string | undefined> {
    this.log.record("readFile", path);
    return this.files.get(path);
  }
}
