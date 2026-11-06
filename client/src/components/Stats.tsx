import { useState } from "react";
import type { LimitHistoryResponse, LogsResponse, StatsPeriodDays, StatsResponse } from "../../../src/server/api-types.js";
import { dateTime, duration } from "../format.js";
import { useLimitHistory, useLogs, useStats } from "../queries.js";
import { LimitChart } from "./LimitChart.js";
import { Banner, CARD, cx, SectionTitle, Segmented } from "./ui.js";

const STAGE_NAMES: Record<StatsResponse["stages"][number]["stage"], string> = { implement: "Реализация", qa: "QA", merge: "Merge" };

const LEVEL_TEXT: Record<string, string> = {
  warn: "text-warn",
  error: "text-danger-text",
  fatal: "text-danger-text",
  debug: "text-muted",
  trace: "text-muted",
};

const PANEL = cx(CARD, "mt-4 p-4");

const plural = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

const roundsLabel = (rounds: number): string => (rounds === 0 ? "без Кругов" : `${rounds} ${plural(rounds, "Круг", "Круга", "Кругов")}`);
const tasksLabel = (tasks: number): string => `${tasks} ${plural(tasks, "Задача", "Задачи", "Задач")}`;

function Tile({ label, value, testId, tone }: { label: string; value: number; testId: string; tone?: string | undefined }) {
  return (
    <div className={cx(CARD, "px-4 py-3")} data-testid={testId}>
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("mt-0.5 text-2xl font-semibold tabular-nums sm:text-3xl", tone)}>{value}</div>
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
  const maxBucket = Math.max(1, ...(stats?.rounds.buckets.map((bucket) => bucket.tasks) ?? []));
  return (
    <main className="mx-auto max-w-4xl px-4 pt-5 pb-20">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Статистика</h1>
        <Segmented<StatsPeriodDays>
          label="Период"
          size="sm"
          value={days}
          onChange={onDays}
          options={[
            { value: 7, label: "7 дней" },
            { value: 30, label: "30 дней" },
          ]}
        />
        {stats && <span className="text-xs text-muted">с {dateTime(stats.since)}</span>}
      </div>
      {error && (
        <Banner tone="danger" role="alert" className="mt-4">
          Статистика не загружена: {error}
        </Banner>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
        <Tile label="Задач взято" value={stats?.taken ?? 0} testId="stat-taken" />
        <Tile label="Влито" value={stats?.done ?? 0} testId="stat-done" tone="text-ok" />
        <Tile label="Тупиков" value={stats?.stuck ?? 0} testId="stat-stuck" tone={stats && stats.stuck > 0 ? "text-danger-text" : undefined} />
      </div>

      <section className={PANEL} aria-label="Время Стадий">
        <SectionTitle>Время Стадий</SectionTitle>
        <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-normal">Стадия</th>
              <th className="py-1 text-right font-normal">Завершено</th>
              <th className="py-1 text-right font-normal">Среднее</th>
              <th className="py-1 text-right font-normal">Медиана</th>
            </tr>
          </thead>
          <tbody>
            {(stats?.stages ?? []).map((stage) => (
              <tr key={stage.stage} data-testid={`stage-${stage.stage}`} className="border-t border-line">
                <td className="py-1.5 font-medium">{STAGE_NAMES[stage.stage]}</td>
                <td className="py-1.5 text-right tabular-nums">{stage.count}</td>
                <td className="py-1.5 text-right tabular-nums">{stage.meanMs === null ? <span className="text-muted">нет данных</span> : duration(stage.meanMs)}</td>
                <td className="py-1.5 text-right tabular-nums">{stage.medianMs === null ? <span className="text-muted">нет данных</span> : duration(stage.medianMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <section className={PANEL} aria-label="Круги QA">
        <SectionTitle>Круги QA</SectionTitle>
        {!stats || stats.rounds.tasks === 0 ? (
          <div className="mt-2 text-sm text-muted" data-testid="rounds-empty">
            Ни одна Задача не завершилась за период.
          </div>
        ) : (
          <>
            <div className="mt-1 text-xs text-muted">
              {tasksLabel(stats.rounds.tasks)}, в среднем {stats.rounds.mean === null ? "нет данных" : stats.rounds.mean.toFixed(1)} Круга на Задачу
            </div>
            <ul className="mt-3 flex flex-col gap-1.5 text-sm" data-testid="rounds">
              {stats.rounds.buckets.map((bucket) => (
                <li key={bucket.rounds} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-right text-muted">{roundsLabel(bucket.rounds)}</span>
                  <span className="h-4 rounded bg-accent" style={{ width: `${Math.max(2, (bucket.tasks / maxBucket) * 60)}%` }} />
                  <span className="text-xs tabular-nums">{tasksLabel(bucket.tasks)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className={PANEL} aria-label="Лимит подписки">
        <SectionTitle>Лимит подписки, % использовано</SectionTitle>
        <div className="mt-2">
          <LimitChart samples={limits?.samples ?? []} since={limits?.since ?? new Date(now - days * 24 * 60 * 60_000).toISOString()} now={now} />
        </div>
      </section>

      <section className={PANEL} aria-label="Журнал Оркестратора">
        <SectionTitle>
          Журнал Оркестратора{logs && <span className="font-normal tracking-normal normal-case"> · последние {logs.lines} строк из {logs.source === "journal" ? "journald" : "памяти процесса"}</span>}
        </SectionTitle>
        {!logs || logs.entries.length === 0 ? (
          <div className="mt-2 text-sm text-muted" data-testid="logs-empty">
            Журнал пуст.
          </div>
        ) : (
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-line bg-surface-2 p-2.5 font-mono text-xs leading-5" data-testid="logs">
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
