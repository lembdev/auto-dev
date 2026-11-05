import { DatabaseSync } from "node:sqlite";
import { AgentStore } from "./agents.js";
import { migrations, type Migration } from "./migrations.js";
import { TaskStore, TransitionStore } from "./tasks.js";

export const IN_MEMORY = ":memory:";

// Key-value settings of the Installation: cursors, pause state, last-known-good versions.
export class InstallationStore {
  constructor(private readonly _db: DatabaseSync) {}

  find(key: string): string | undefined {
    const row = this._db.prepare("SELECT value FROM installation WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this._db
      .prepare("INSERT INTO installation (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  delete(key: string): void {
    this._db.prepare("DELETE FROM installation WHERE key = ?").run(key);
  }

  all(): Record<string, string> {
    const rows = this._db.prepare("SELECT key, value FROM installation ORDER BY key").all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }
}

export class RuntimeIndex {
  readonly installation: InstallationStore;
  readonly agents: AgentStore;
  readonly tasks: TaskStore;
  readonly transitions: TransitionStore;

  constructor(readonly db: DatabaseSync) {
    this.installation = new InstallationStore(db);
    this.agents = new AgentStore(db);
    this.tasks = new TaskStore(db);
    this.transitions = new TransitionStore(db);
  }

  // Runs `fn` inside one SQLite transaction; a thrown error rolls everything back.
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as {
      version: number | null;
    };
    return row.version ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

export class SchemaVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`runtime index schema version ${found} is newer than the supported ${supported}; this release cannot open it`);
    this.name = "SchemaVersionError";
  }
}

export type OpenRuntimeIndexOptions = {
  migrations?: Migration[];
};

// Opens (or creates) the index at `path` and migrates it forward. `:memory:` gives a throwaway index for tests.
export function openRuntimeIndex(path: string, options: OpenRuntimeIndexOptions = {}): RuntimeIndex {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  applyMigrations(db, options.migrations ?? migrations);
  return new RuntimeIndex(db);
}

export function applyMigrations(db: DatabaseSync, list: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const sorted = [...list].sort((a, b) => a.version - b.version);
  const latest = sorted.at(-1)?.version ?? 0;
  const current = (db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null })
    .version ?? 0;
  if (current > latest) throw new SchemaVersionError(current, latest);
  for (const migration of sorted) {
    if (migration.version <= current) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
