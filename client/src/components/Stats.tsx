import { useState } from "react";
import type { LimitHistoryResponse, LogsResponse, StatsPeriodDays, StatsResponse } from "../../../src/server/api-types.js";
import { dateTime, duration } from "../format.js";
import { useLimitHistory, useLogs, useStats } from "../queries.js";
import { LimitChart } from "./LimitChart.js";

const STAGE_NAMES: Record<StatsResponse["stages"][number]["stage"], string> = { implement: "Реализация", qa: "QA", merge: "Merge" };

const LEVEL_TEXT: Record<string, string> = {
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
  fatal: "text-red-600 dark:text-red-400",
  debug: "text-neutral-500",
  trace: "text-neutral-500",
};

const CARD = "rounded-lg border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900";

const plural = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

const roundsLabel = (rounds: number): string => (rounds === 0 ? "без Кругов" : `${rounds} ${plural(rounds, "Круг", "Круга", "Кругов")}`);
const tasksLabel = (tasks: number): string => `${tasks} ${plural(tasks, "Задача", "Задачи", "Задач")}`;

function Tile({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className={CARD} data-testid={testId}>
      <div className="text-xs text-neutral-500 uppercase">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export type StatsViewProps = {
  days: StatsPeriodDays;
  onDays: (days: StatsPeriodDays) => void;
  stats: StatsResponse | undefined;
  limits: LimitHistoryResponse | undefined;
  logs: LogsResponse | undefined;
  error: string | null;
  now: number;
};

// The page itself, given its data: tiles, Stage times, Rounds, the limit chart and the journal tail.
export function StatsView({ days, onDays, stats, limits, logs, error, now }: StatsViewProps) {
  const period = (value: StatsPeriodDays) => (
    <button
      type="button"
      onClick={() => onDays(value)}
      aria-pressed={days === value}
      className={`px-3 py-1 ${days === value ? "bg-blue-600 text-white" : "hover:bg-neutral-200 dark:hover:bg-neutral-700"}`}
    >
      {value} дней
    </button>
  );
  const maxBucket = Math.max(1, ...(stats?.rounds.buckets.map((bucket) => bucket.tasks) ?? []));
  return (
    <main className="mx-auto max-w-4xl px-4 pt-3 pb-20">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Статистика</h1>
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 text-sm dark:border-neutral-700" aria-label="Период">
          {period(7)}
          {period(30)}
        </div>
        {stats && <span className="text-xs text-neutral-500">с {dateTime(stats.since)}</span>}
      </div>
      {error && (
        <div className="mt-3 text-sm text-red-600" role="alert">
          Статистика не загружена: {error}
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-3">
        <Tile label="Задач взято" value={stats?.taken ?? 0} testId="stat-taken" />
        <Tile label="Влито" value={stats?.done ?? 0} testId="stat-done" />
        <Tile label="Тупиков" value={stats?.stuck ?? 0} testId="stat-stuck" />
      </div>

      <section className={`${CARD} mt-4`} aria-label="Время Стадий">
        <h2 className="text-[13px] font-semibold tracking-wide text-neutral-500 uppercase">Время Стадий</h2>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th className="py-1 font-normal">Стадия</th>
              <th className="py-1 font-normal">Завершено</th>
              <th className="py-1 font-normal">Среднее</th>
              <th className="py-1 font-normal">Медиана</th>
            </tr>
          </thead>
          <tbody>
            {(stats?.stages ?? []).map((stage) => (
              <tr key={stage.stage} data-testid={`stage-${stage.stage}`} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="py-1">{STAGE_NAMES[stage.stage]}</td>
                <td className="py-1 tabular-nums">{stage.count}</td>
                <td className="py-1">{stage.meanMs === null ? <span className="text-neutral-500">нет данных</span> : duration(stage.meanMs)}</td>
                <td className="py-1">{stage.medianMs === null ? <span className="text-neutral-500">нет данных</span> : duration(stage.medianMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={`${CARD} mt-4`} aria-label="Круги QA">
        <h2 className="text-[13px] font-semibold tracking-wide text-neutral-500 uppercase">Круги QA</h2>
        {!stats || stats.rounds.tasks === 0 ? (
          <div className="mt-2 text-sm text-neutral-500" data-testid="rounds-empty">
            Ни одна Задача не завершилась за период.
          </div>
        ) : (
          <>
            <div className="mt-1 text-xs text-neutral-500">
              {tasksLabel(stats.rounds.tasks)}, в среднем {stats.rounds.mean === null ? "нет данных" : stats.rounds.mean.toFixed(1)} Круга на Задачу
            </div>
            <ul className="mt-2 flex flex-col gap-1 text-sm" data-testid="rounds">
              {stats.rounds.buckets.map((bucket) => (
                <li key={bucket.rounds} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-right text-neutral-600 dark:text-neutral-400">{roundsLabel(bucket.rounds)}</span>
                  <span className="h-3 rounded-sm bg-blue-600 dark:bg-blue-500" style={{ width: `${Math.max(2, (bucket.tasks / maxBucket) * 60)}%` }} />
                  <span className="tabular-nums">{tasksLabel(bucket.tasks)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className={`${CARD} mt-4`} aria-label="Лимит подписки">
        <h2 className="text-[13px] font-semibold tracking-wide text-neutral-500 uppercase">Лимит подписки, % использовано</h2>
        <div className="mt-2">
          <LimitChart samples={limits?.samples ?? []} since={limits?.since ?? new Date(now - days * 24 * 60 * 60_000).toISOString()} now={now} />
        </div>
      </section>

      <section className={`${CARD} mt-4`} aria-label="Журнал Оркестратора">
        <h2 className="text-[13px] font-semibold tracking-wide text-neutral-500 uppercase">
          Журнал Оркестратора{logs && <span className="font-normal normal-case"> · последние {logs.lines} строк из {logs.source === "journal" ? "journald" : "памяти процесса"}</span>}
        </h2>
        {!logs || logs.entries.length === 0 ? (
          <div className="mt-2 text-sm text-neutral-500" data-testid="logs-empty">
            Журнал пуст.
          </div>
        ) : (
          <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-neutral-100 p-2 font-mono text-xs leading-5 dark:bg-neutral-950" data-testid="logs">
            {logs.entries.map((entry, index) => (
              <div key={index} className={LEVEL_TEXT[entry.level ?? ""] ?? ""} title={entry.raw}>
                {entry.at ? `${dateTime(entry.at)} ` : ""}
                {entry.level ? `${entry.level.padEnd(5)} ` : ""}
                {entry.msg}
              </div>
            ))}
          </pre>
        )}
      </section>
    </main>
  );
}

// The page wired to the API: the period is page state, the queries follow it.
export function StatsPage({ now }: { now: number }) {
  const [days, setDays] = useState<StatsPeriodDays>(7);
  const stats = useStats(days);
  const limits = useLimitHistory(days);
  const logs = useLogs();
  const error = stats.error?.message ?? limits.error?.message ?? logs.error?.message ?? null;
  return <StatsView days={days} onDays={setDays} stats={stats.data} limits={limits.data} logs={logs.data} error={error} now={now} />;
}
