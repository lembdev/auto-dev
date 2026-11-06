import { describe, expect, it } from "vitest";
import { createJournalLogSource, type JournalExec } from "../../src/adapters/journal.js";
import { LogBuffer } from "../../src/log.js";

describe("journal log source", () => {
  const buffer = () => {
    const fallback = new LogBuffer(10);
    fallback.write('{"msg":"from buffer"}\n');
    return fallback;
  };

  it("asks journalctl for the unit's tail and returns its lines", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec: JournalExec = async (command, args) => {
      calls.push({ command, args });
      return { stdout: '{"msg":"one"}\n{"msg":"two"}\n' };
    };
    const source = createJournalLogSource({ unit: "auto-dev", fallback: buffer(), exec });
    expect(await source.tail(2)).toEqual({ source: "journal", lines: ['{"msg":"one"}', '{"msg":"two"}'] });
    expect(calls).toEqual([{ command: "journalctl", args: ["-u", "auto-dev", "-n", "2", "-o", "cat", "--no-pager"] }]);
  });

  it("falls back to the in-memory buffer when journalctl fails or is empty", async () => {
    const failing = createJournalLogSource({ unit: "auto-dev", fallback: buffer(), exec: async () => Promise.reject(new Error("ENOENT")) });
    expect(await failing.tail(5)).toEqual({ source: "buffer", lines: ['{"msg":"from buffer"}'] });
    const empty = createJournalLogSource({ unit: "auto-dev", fallback: buffer(), exec: async () => ({ stdout: "" }) });
    expect(await empty.tail(5)).toEqual({ source: "buffer", lines: ['{"msg":"from buffer"}'] });
  });
});
