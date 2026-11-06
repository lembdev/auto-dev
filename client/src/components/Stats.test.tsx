import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LimitHistoryResponse, LogsResponse, StatsResponse } from "../../../src/server/api-types.js";
import { StatsView } from "./Stats.js";

const NOW = Date.parse("2026-01-08T12:00:00.000Z");
const SINCE = "2026-01-01T12:00:00.000Z";

const emptyStats: StatsResponse = {
  days: 7,
  since: SINCE,
  taken: 0,
  done: 0,
  stuck: 0,
  stages: [
    { stage: "implement", count: 0, meanMs: null, medianMs: null },
    { stage: "qa", count: 0, meanMs: null, medianMs: null },
    { stage: "merge", count: 0, meanMs: null, medianMs: null },
  ],
  rounds: { tasks: 0, mean: null, buckets: [] },
};

describe("StatsView", () => {
  it("renders zeros, empty chart and empty journal on an empty index", () => {
    render(
      <StatsView
        days={7}
        onDays={vi.fn()}
        stats={emptyStats}
        limits={{ days: 7, since: SINCE, samples: [] }}
        logs={{ lines: 500, source: "buffer", entries: [] }}
        error={null}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("stat-taken")).toHaveTextContent("0");
    expect(screen.getByTestId("stat-done")).toHaveTextContent("0");
    expect(screen.getByTestId("stat-stuck")).toHaveTextContent("0");
    expect(screen.getByTestId("stage-qa")).toHaveTextContent("нет данных");
    expect(screen.getByTestId("rounds-empty")).toBeInTheDocument();
    expect(screen.getByTestId("limit-chart-empty")).toBeInTheDocument();
    expect(screen.getByTestId("logs-empty")).toBeInTheDocument();
  });

  it("renders before any data arrived and switches the period", () => {
    const onDays = vi.fn();
    render(<StatsView days={7} onDays={onDays} stats={undefined} limits={undefined} logs={undefined} error={null} now={NOW} />);
    expect(screen.getByRole("button", { name: "7 дней" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "30 дней" }));
    expect(onDays).toHaveBeenCalledWith(30);
    expect(screen.getByTestId("stat-taken")).toHaveTextContent("0");
  });

  it("shows the aggregates, the Rounds, the limit lines and the journal lines", () => {
    const stats: StatsResponse = {
      ...emptyStats,
      taken: 5,
      done: 3,
      stuck: 1,
      stages: [
        { stage: "implement", count: 4, meanMs: 2 * 60 * 60_000 + 10 * 60_000, medianMs: 90 * 60_000 },
        { stage: "qa", count: 4, meanMs: 30 * 60_000, medianMs: 25 * 60_000 },
        { stage: "merge", count: 3, meanMs: 5 * 60_000, medianMs: 5 * 60_000 },
      ],
      rounds: { tasks: 4, mean: 1.5, buckets: [{ rounds: 1, tasks: 2 }, { rounds: 2, tasks: 2 }] },
    };
    const reading = (usedPercent: number, at: string) => ({ usedPercent, resetsAt: null, at, source: "statusline" as const });
    const limits: LimitHistoryResponse = {
      days: 7,
      since: SINCE,
      samples: [
        { id: 1 as never, at: "2026-01-02T00:00:00.000Z", fiveHour: reading(10, "2026-01-02T00:00:00.000Z"), sevenDay: reading(5, "2026-01-02T00:00:00.000Z") },
        { id: 2 as never, at: "2026-01-05T00:00:00.000Z", fiveHour: reading(60, "2026-01-05T00:00:00.000Z"), sevenDay: null },
        { id: 3 as never, at: "2026-01-07T00:00:00.000Z", fiveHour: reading(80, "2026-01-07T00:00:00.000Z"), sevenDay: reading(40, "2026-01-07T00:00:00.000Z") },
      ],
    };
    const logs: LogsResponse = {
      lines: 500,
      source: "journal",
      entries: [
        { at: "2026-01-08T11:00:00.000Z", level: "info", msg: "task stage changed", raw: '{"msg":"task stage changed"}' },
        { at: "2026-01-08T11:01:00.000Z", level: "warn", msg: "poll failed", raw: '{"msg":"poll failed"}' },
      ],
    };
    render(<StatsView days={7} onDays={vi.fn()} stats={stats} limits={limits} logs={logs} error={null} now={NOW} />);
    expect(screen.getByTestId("stat-taken")).toHaveTextContent("5");
    expect(screen.getByTestId("stat-done")).toHaveTextContent("3");
    expect(screen.getByTestId("stat-stuck")).toHaveTextContent("1");
    expect(screen.getByTestId("stage-implement")).toHaveTextContent("Реализация42 ч 10 мин1 ч 30 мин");
    expect(screen.getByTestId("rounds")).toHaveTextContent("1 Круг2 Задачи");
    expect(screen.getByTestId("rounds")).toHaveTextContent("2 Круга2 Задачи");
    // The 7-day series breaks where a sample has no reading: two runs; the 5-hour series is one run.
    const chart = screen.getByTestId("limit-chart");
    expect(chart.querySelectorAll('polyline[data-series="fiveHour"]')).toHaveLength(1);
    expect(chart.querySelectorAll('polyline[data-series="sevenDay"]')).toHaveLength(2);
    expect(screen.getByTestId("logs")).toHaveTextContent("task stage changed");
    expect(screen.getByTestId("logs")).toHaveTextContent("warn poll failed");
    expect(screen.getByText(/из journald/)).toBeInTheDocument();
  });
});
