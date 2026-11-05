import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrations, type Migration } from "../../src/index/migrations.js";
import { IN_MEMORY, SchemaVersionError, openRuntimeIndex } from "../../src/index/runtime-index.js";
import { TaskNotFoundError } from "../../src/index/tasks.js";
import type { IssueNumber, MilestoneNumber } from "../../src/ids.js";

const tableNames = (db: { prepare(sql: string): { all(): unknown[] } }): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );

describe("runtime index", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-index-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the schema version table and the installation table in memory", () => {
    const index = openRuntimeIndex(IN_MEMORY);
    expect(index.schemaVersion()).toBe(migrations.at(-1)?.version);
    expect(tableNames(index.db)).toEqual(["agents", "installation", "intents", "schema_version", "sqlite_sequence", "tasks", "transitions"]);
    index.close();
  });

  it("keeps tasks and their transitions", () => {
    const index = openRuntimeIndex(IN_MEMORY);
    const issue = 42 as IssueNumber;
    const milestone = { number: 1 as MilestoneNumber, title: "Эпик 1" };
    expect(index.tasks.find(issue)).toBeUndefined();
    expect(() => index.tasks.get(issue)).toThrow(TaskNotFoundError);

    index.transaction(() => {
      index.tasks.insert({ issueNumber: issue, title: "Add login", milestone, stage: "taken", takenAt: "t0" }, "t0");
      index.transitions.append({ issueNumber: issue, from: null, to: "taken", reason: null, at: "t0" });
    });
    expect(index.tasks.get(issue)).toEqual({
      issueNumber: 42,
      title: "Add login",
      milestone,
      stage: "taken",
      round: 0,
      attempt: 1,
      pullNumber: null,
      branch: null,
      worktreePath: null,
      takenAt: "t0",
      updatedAt: "t0",
    });

    index.tasks.update(issue, { stage: "implement", branch: "worktree-issue-42" }, "t1");
    index.transitions.append({ issueNumber: issue, from: "taken", to: "implement", reason: null, at: "t1" });
    expect(index.tasks.listActive().map((task) => task.stage)).toEqual(["implement"]);

    index.tasks.update(issue, { stage: "done" }, "t2");
    expect(index.tasks.listActive()).toEqual([]);
    expect(index.transitions.listFor(issue).map((t) => [t.from, t.to, t.at])).toEqual([
      [null, "taken", "t0"],
      ["taken", "implement", "t1"],
    ]);
    index.close();
  });

  it("rolls a failed transaction back", () => {
    const index = openRuntimeIndex(IN_MEMORY);
    expect(() =>
      index.transaction(() => {
        index.tasks.insert({ issueNumber: 1 as IssueNumber, title: "a", milestone: null, stage: "taken", takenAt: "t" }, "t");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(index.tasks.list()).toEqual([]);
    index.close();
  });

  it("creates runtime.db on disk and survives a second open without touching the schema", () => {
    const file = path.join(tempDir(), "runtime.db");

    const first = openRuntimeIndex(file);
    first.installation.set("claude_version", "2.1.318");
    const version = first.schemaVersion();
    first.close();

    const second = openRuntimeIndex(file);
    expect(second.schemaVersion()).toBe(version);
    expect(second.installation.find("claude_version")).toBe("2.1.318");
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM schema_version").get()).toEqual({ n: version });
    second.close();
  });

  it("applies only the migrations newer than the stored version", () => {
    const file = path.join(tempDir(), "runtime.db");
    const applied: number[] = [];
    const v1: Migration = { version: 1, up: (db) => { applied.push(1); db.exec("CREATE TABLE a (x INTEGER)"); } };
    const v2: Migration = { version: 2, up: (db) => { applied.push(2); db.exec("CREATE TABLE b (y INTEGER)"); } };

    openRuntimeIndex(file, { migrations: [v1] }).close();
    expect(applied).toEqual([1]);

    const index = openRuntimeIndex(file, { migrations: [v1, v2] });
    expect(applied).toEqual([1, 2]);
    expect(index.schemaVersion()).toBe(2);
    expect(tableNames(index.db)).toEqual(["a", "b", "schema_version"]);
    index.close();
  });

  it("rolls a failed migration back and leaves the version untouched", () => {
    const file = path.join(tempDir(), "runtime.db");
    const v1: Migration = { version: 1, up: (db) => db.exec("CREATE TABLE a (x INTEGER)") };
    const broken: Migration = {
      version: 2,
      up: (db) => {
        db.exec("CREATE TABLE b (y INTEGER)");
        throw new Error("boom");
      },
    };
    openRuntimeIndex(file, { migrations: [v1] }).close();

    expect(() => openRuntimeIndex(file, { migrations: [v1, broken] })).toThrow("boom");

    const index = openRuntimeIndex(file, { migrations: [v1] });
    expect(index.schemaVersion()).toBe(1);
    expect(tableNames(index.db)).toEqual(["a", "schema_version"]);
    index.close();
  });

  it("refuses an index written by a newer release", () => {
    const file = path.join(tempDir(), "runtime.db");
    const v1: Migration = { version: 1, up: () => {} };
    const v2: Migration = { version: 2, up: () => {} };
    openRuntimeIndex(file, { migrations: [v1, v2] }).close();

    expect(() => openRuntimeIndex(file, { migrations: [v1] })).toThrow(SchemaVersionError);
  });

  it("stores installation settings as key-value pairs", () => {
    const index = openRuntimeIndex(IN_MEMORY);
    expect(index.installation.find("paused")).toBeUndefined();
    index.installation.set("paused", "true");
    index.installation.set("paused", "false");
    index.installation.set("since", "2026-01-01T00:00:00Z");
    expect(index.installation.all()).toEqual({ paused: "false", since: "2026-01-01T00:00:00Z" });
    index.installation.delete("since");
    expect(index.installation.find("since")).toBeUndefined();
    index.close();
  });
});
