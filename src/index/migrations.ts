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
];
