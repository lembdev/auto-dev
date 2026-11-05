import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrations, type Migration } from "../../src/index/migrations.js";
import { IN_MEMORY, SchemaVersionError, openRuntimeIndex } from "../../src/index/runtime-index.js";

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
    expect(tableNames(index.db)).toEqual(["agents", "installation", "schema_version", "sqlite_sequence"]);
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
