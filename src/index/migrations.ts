import type { DatabaseSync } from "node:sqlite";

export type Migration = {
  version: number;
  up(db: DatabaseSync): void;
};

// Forward-only migrations, applied in order. New tables and columns get a new entry appended here;
// an existing entry is never edited once released.
export const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE installation (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE tasks (
          issue_number INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          milestone_number INTEGER,
          milestone_title TEXT,
          stage TEXT NOT NULL,
          round INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 1,
          pull_number INTEGER,
          branch TEXT,
          worktree_path TEXT,
          taken_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX tasks_stage ON tasks (stage);

        CREATE TABLE transitions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_number INTEGER NOT NULL,
          from_stage TEXT,
          to_stage TEXT NOT NULL,
          reason TEXT,
          at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX transitions_issue ON transitions (issue_number, id);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_number INTEGER,
          role TEXT NOT NULL,
          cwd TEXT NOT NULL,
          session_id TEXT,
          state TEXT NOT NULL,
          pid INTEGER,
          last_turn_at TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX agents_issue_number ON agents (issue_number);
        CREATE UNIQUE INDEX agents_session_id ON agents (session_id);
      `);
    },
  },
];
