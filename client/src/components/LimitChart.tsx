import { useState } from "react";
import type { LimitSample } from "../../../src/index/limit-samples.js";
import { dateTime } from "../format.js";

export type LimitChartProps = {
  samples: LimitSample[];
  // Window of the x axis: samples are placed between `since` and `now`.
  since: string;
  now: number;
};

const WIDTH = 640;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 36 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

type Series = { key: "fiveHour" | "sevenDay"; label: string; stroke: string };

// Two hues apart enough for colour-blind readers; the legend and the tooltip name the series by text.
const SERIES: Series[] = [
  { key: "fiveHour", label: "5 ч", stroke: "stroke-blue-600 dark:stroke-blue-500" },
  { key: "sevenDay", label: "7 дн", stroke: "stroke-orange-600" },
];
const SWATCH: Record<Series["key"], string> = { fiveHour: "bg-blue-600 dark:bg-blue-500", sevenDay: "bg-orange-600" };

// Consecutive readings make one run; a missing reading breaks the line instead of bridging the gap.
const runs = (samples: LimitSample[], key: Series["key"], x: (iso: string) => number, y: (percent: number) => number): string[] => {
  const paths: string[] = [];
  let points: string[] = [];
  const close = () => {
    if (points.length > 0) paths.push(points.join(" "));
    points = [];
  };
  for (const sample of samples) {
    const reading = sample[key];
    if (reading === null) close();
    else points.push(`${x(sample.at).toFixed(1)},${y(reading.usedPercent).toFixed(1)}`);
  }
  close();
  return paths;
};

// Percent used of both subscription windows over the period: one y axis from 0 to 100, time along x.
export function LimitChart({ samples, since, now }: LimitChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const start = Date.parse(since);
  const span = Math.max(1, now - start);
  const x = (iso: string): number => PAD.left + (Math.min(Math.max(Date.parse(iso) - start, 0), span) / span) * PLOT_W;
  const y = (percent: number): number => PAD.top + PLOT_H - (Math.min(Math.max(percent, 0), 100) / 100) * PLOT_H;

  if (samples.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-neutral-500" data-testid="limit-chart-empty">
        Нет снимков лимита за период: они появляются раз в 10 минут, пока Оркестратор работает.
      </div>
    );
  }

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let best = Infinity;
    samples.forEach((sample, index) => {
      const distance = Math.abs(x(sample.at) - px);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    setHover(nearest);
  };
  const hovered = hover === null ? null : (samples[hover] ?? null);
  const ticks = [0, 25, 50, 75, 100];

  return (
    <div>
      <div className="mb-1 flex gap-4 text-xs text-neutral-600 dark:text-neutral-400" aria-label="Легенда">
        {SERIES.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-1.5">
            <i className={`inline-block h-2 w-2 rounded-full ${SWATCH[series.key]}`} />
            {series.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label="График использования лимита подписки"
        data-testid="limit-chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-neutral-200 dark:stroke-neutral-800" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(tick) + 3.5} textAnchor="end" className="fill-neutral-500 text-[10px]">
              {tick}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 8} className="fill-neutral-500 text-[10px]">
          {dateTime(since)}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} textAnchor="end" className="fill-neutral-500 text-[10px]">
          {dateTime(new Date(now).toISOString())}
        </text>
        {SERIES.map((series) =>
          runs(samples, series.key, x, y).map((points, index) => (
            <polyline key={`${series.key}-${index}`} points={points} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={series.stroke} data-series={series.key} />
          )),
        )}
        {hovered && (
          <g data-testid="limit-chart-hover">
            <line x1={x(hovered.at)} x2={x(hovered.at)} y1={PAD.top} y2={PAD.top + PLOT_H} className="stroke-neutral-400" strokeWidth={1} strokeDasharray="3 3" />
            {SERIES.map((series) => {
              const reading = hovered[series.key];
              return reading === null ? null : <circle key={series.key} cx={x(hovered.at)} cy={y(reading.usedPercent)} r={4} className={`fill-white dark:fill-neutral-900 ${series.stroke}`} strokeWidth={2} />;
            })}
          </g>
        )}
      </svg>
      <div className="h-5 text-xs text-neutral-600 dark:text-neutral-400" data-testid="limit-chart-tooltip">
        {hovered
          ? `${dateTime(hovered.at)}: ${SERIES.map((series) => `${series.label} ${hovered[series.key] === null ? "нет данных" : `${Math.round(hovered[series.key]!.usedPercent)} %`}`).join(" · ")}`
          : "Наведите на график, чтобы увидеть значения"}
      </div>
    </div>
  );
}
