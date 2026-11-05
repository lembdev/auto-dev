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
        CREATE TABLE intents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL,
          result TEXT,
          created_at TEXT NOT NULL,
          done_at TEXT
        ) STRICT;
        CREATE INDEX intents_state ON intents (state, id);
        CREATE INDEX intents_issue ON intents (issue_number, id);
      `);
    },
  },
];
