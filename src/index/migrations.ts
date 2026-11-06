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
  {
    version: 4,
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
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE human_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id INTEGER NOT NULL,
          issue_number INTEGER NOT NULL,
          tool_use_id TEXT NOT NULL,
          comment_id INTEGER,
          created_at TEXT NOT NULL,
          answered_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX human_requests_tool_use ON human_requests (tool_use_id);
        CREATE INDEX human_requests_issue ON human_requests (issue_number, id);
        CREATE INDEX human_requests_open ON human_requests (answered_at, id);

        CREATE TABLE applied_answers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id INTEGER NOT NULL,
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX applied_answers_source ON applied_answers (source_kind, source_id);
        CREATE INDEX applied_answers_request ON applied_answers (request_id, id);
      `);
    },
  },
  {
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE limit_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          five_hour REAL,
          five_hour_resets_at TEXT,
          five_hour_at TEXT,
          five_hour_source TEXT,
          seven_day REAL,
          seven_day_resets_at TEXT,
          seven_day_at TEXT,
          seven_day_source TEXT
        ) STRICT;
        CREATE INDEX limit_samples_at ON limit_samples (at);
      `);
    },
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_number INTEGER NOT NULL,
          agent_id INTEGER,
          request_id INTEGER,
          client_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          delivered_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX pending_messages_identity ON pending_messages (client_id, seq);
        CREATE INDEX pending_messages_issue ON pending_messages (issue_number, id);
        CREATE INDEX pending_messages_undelivered ON pending_messages (delivered_at, id);

        CREATE TABLE dialogue_clients (
          client_id TEXT PRIMARY KEY,
          watermark INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
];
