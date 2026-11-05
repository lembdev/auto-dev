import type { DatabaseSync } from "node:sqlite";

export type LimitSampleId = number & { __brand: "LimitSampleId" };

export const LIMIT_SOURCES = ["event", "statusline"] as const;
// Where a reading came from: the `rate_limit_event` of an Agent process or the statusline file.
export type LimitSource = (typeof LIMIT_SOURCES)[number];

// One reading of a subscription window: percent used and when the window resets.
export type LimitReading = {
  usedPercent: number;
  // ISO timestamp; null when the source did not report it.
  resetsAt: string | null;
  // ISO timestamp of the reading.
  at: string;
  source: LimitSource;
};

// Snapshot of both windows, taken every few minutes for the limit chart.
export type LimitSample = {
  id: LimitSampleId;
  at: string;
  fiveHour: LimitReading | null;
  sevenDay: LimitReading | null;
};

export type NewLimitSample = Omit<LimitSample, "id">;

type Row = {
  id: number;
  at: string;
  five_hour: number | null;
  five_hour_resets_at: string | null;
  five_hour_at: string | null;
  five_hour_source: string | null;
  seven_day: number | null;
  seven_day_resets_at: string | null;
  seven_day_at: string | null;
  seven_day_source: string | null;
};

const reading = (usedPercent: number | null, resetsAt: string | null, at: string | null, source: string | null): LimitReading | null =>
  usedPercent === null || at === null || source === null ? null : { usedPercent, resetsAt, at, source: source as LimitSource };

const toSample = (row: Row): LimitSample => ({
  id: row.id as LimitSampleId,
  at: row.at,
  fiveHour: reading(row.five_hour, row.five_hour_resets_at, row.five_hour_at, row.five_hour_source),
  sevenDay: reading(row.seven_day, row.seven_day_resets_at, row.seven_day_at, row.seven_day_source),
});

export class LimitSampleStore {
  constructor(private readonly _db: DatabaseSync) {}

  insert(sample: NewLimitSample): LimitSample {
    const result = this._db
      .prepare(
        `INSERT INTO limit_samples (at, five_hour, five_hour_resets_at, five_hour_at, five_hour_source,
           seven_day, seven_day_resets_at, seven_day_at, seven_day_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sample.at,
        sample.fiveHour?.usedPercent ?? null,
        sample.fiveHour?.resetsAt ?? null,
        sample.fiveHour?.at ?? null,
        sample.fiveHour?.source ?? null,
        sample.sevenDay?.usedPercent ?? null,
        sample.sevenDay?.resetsAt ?? null,
        sample.sevenDay?.at ?? null,
        sample.sevenDay?.source ?? null,
      );
    const row = this._db.prepare("SELECT * FROM limit_samples WHERE id = ?").get(Number(result.lastInsertRowid)) as Row;
    return toSample(row);
  }

  // Samples taken at or after `since`, oldest first; all of them without it.
  list(options: { since?: string } = {}): LimitSample[] {
    const rows = options.since
      ? (this._db.prepare("SELECT * FROM limit_samples WHERE at >= ? ORDER BY id").all(options.since) as Row[])
      : (this._db.prepare("SELECT * FROM limit_samples ORDER BY id").all() as Row[]);
    return rows.map(toSample);
  }

  // Drops samples taken before `before`; returns how many went.
  deleteBefore(before: string): number {
    return Number(this._db.prepare("DELETE FROM limit_samples WHERE at < ?").run(before).changes);
  }
}
