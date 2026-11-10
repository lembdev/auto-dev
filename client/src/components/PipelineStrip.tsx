import { Fragment } from "react";
import { duration } from "../format.js";
import { isLive, type NodeStage, type NodeStatus, type Pipeline, type PipelineNode } from "../pipeline.js";
import { cx } from "./ui.js";

export type PipelineStripProps = {
  pipeline: Pipeline;
  now: number;
  selectedKey: string | null;
  onSelect: (node: PipelineNode) => void;
  // "sm" for the rows of finished Tasks.
  size?: "md" | "sm";
};

const STATUS_TEXT: Record<NodeStatus, string> = {
  ok: "",
  rejected: "",
  failed: "",
  running: "работает",
  waiting: "ждёт человека",
  idle: "idle",
  pending: "впереди",
};

// Colour only where it carries news: a finished step is neutral, the live one and the troubled ones stand out.
const TILE: Record<NodeStatus, string> = {
  ok: "border-line-strong bg-surface text-fg/70",
  rejected: "border-line-strong bg-surface text-fg/70",
  failed: "border-danger/60 bg-danger-soft text-danger-text",
  running: "border-accent bg-accent-soft text-link shadow-[0_0_0_3px_color-mix(in_oklab,var(--app-accent)_20%,transparent)]",
  waiting: "border-warn-line bg-warn-soft text-warn",
  idle: "border-accent/60 bg-surface text-link",
  pending: "border-dashed border-line-strong bg-transparent text-muted opacity-60",
};

const MARK: Partial<Record<NodeStatus, string>> = {
  rejected: "bg-warn-line",
  failed: "bg-danger",
};

function StageIcon({ stage, className }: { stage: NodeStage; className: string }) {
  const common = { "aria-hidden": true, viewBox: "0 0 16 16", className, fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (stage) {
    case "implement":
      return (
        <svg {...common}>
          <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
        </svg>
      );
    case "qa":
      return (
        <svg {...common}>
          <path d="M8 1.75 2.75 3.5v4c0 3 2.2 5.4 5.25 6.75 3.05-1.35 5.25-3.75 5.25-6.75v-4L8 1.75Z" />
          <path d="m5.75 8 1.6 1.6 2.9-3.1" />
        </svg>
      );
    case "merge":
      return (
        <svg {...common}>
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="4.5" cy="12.5" r="1.5" />
          <circle cx="11.5" cy="8" r="1.5" />
          <path d="M4.5 5v6M4.5 5c0 2.5 2 3 5.5 3" />
        </svg>
      );
  }
}

export const spanOf = (node: PipelineNode, now: number): string | null =>
  node.startedAt ? duration((node.endedAt ? Date.parse(node.endedAt) : now) - Date.parse(node.startedAt)) : null;

// What a step was: its title, how it ended or what it does now, how long it took.
export function describeNode(node: PipelineNode, now: number): string {
  return [node.title, node.outcome ?? STATUS_TEXT[node.status], spanOf(node, now)].filter(Boolean).join(" · ");
}

function Node({ node, now, selected, onSelect, size }: { node: PipelineNode; now: number; selected: boolean; onSelect: (node: PipelineNode) => void; size: "md" | "sm" }) {
  const clickable = node.status !== "pending" && node.agent !== null;
  const about = describeNode(node, now);
  const hint = node.status === "pending" ? `${node.title}: шаг ещё впереди` : node.agent === null ? `${about}. Шаг делает сам Оркестратор, лога Агента нет` : `${about}. Открыть лог`;
  const mark = MARK[node.status];
  return (
    <button
      type="button"
      disabled={!clickable}
      title={hint}
      aria-label={hint}
      aria-pressed={clickable ? selected : undefined}
      data-testid={`node-${node.key}`}
      data-status={node.status}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node);
      }}
      className={cx(
        "relative flex shrink-0 items-center justify-center rounded-lg border transition-[border-color,box-shadow]",
        size === "sm" ? "h-6 w-6 rounded-md" : "h-8 w-8",
        TILE[node.status],
        clickable ? "cursor-pointer hover:border-accent" : "cursor-default",
        selected && "ring-2 ring-accent ring-offset-1 ring-offset-app",
      )}
    >
      <StageIcon stage={node.stage} className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
      <span className="sr-only">{about}</span>
      {node.status === "running" && <span aria-hidden className="absolute inset-0 animate-ping rounded-[inherit] border border-accent opacity-40" />}
      {mark && <span aria-hidden className={cx("absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface", mark)} />}
    </button>
  );
}

function Connector({ pending, size }: { pending: boolean; size: "md" | "sm" }) {
  return <span aria-hidden className={cx("h-px shrink-0 border-t", size === "sm" ? "w-2" : "w-4", pending ? "border-dashed border-line-strong" : "border-line-strong")} />;
}

// The Pipeline of one Task as a row of step tiles joined by a line, wrapping instead of scrolling.
// Each tile names its step in the hint; a click opens that step's feed.
export function PipelineStrip({ pipeline, selectedKey, onSelect, now, size = "md" }: PipelineStripProps) {
  return (
    <div className={cx("flex items-center gap-y-1.5", size === "sm" ? "shrink-0" : "flex-wrap")} data-testid="pipeline">
      {pipeline.nodes.map((node, index) => (
        <Fragment key={node.key}>
          {index > 0 && <Connector pending={node.status === "pending"} size={size} />}
          <Node node={node} now={now} selected={selectedKey === node.key} onSelect={onSelect} size={size} />
        </Fragment>
      ))}
      {pipeline.end === "stuck" && (
        <>
          <Connector pending={false} size={size} />
          <span className="shrink-0 rounded-full border border-danger/40 bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger-text" data-testid="pipeline-end">
            тупик
          </span>
        </>
      )}
      {pipeline.end === "cancelled" && (
        <>
          <Connector pending={false} size={size} />
          <span className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-medium text-muted" data-testid="pipeline-end">
            отменена
          </span>
        </>
      )}
    </div>
  );
}

// The live step in words, next to the tiles of an active Task: the Stage as the card names it and
// how long the step has been going.
export function LiveStep({ pipeline, label, now }: { pipeline: Pipeline; label: string; now: number }) {
  const node = pipeline.nodes.find(isLive);
  const span = node ? spanOf(node, now) : null;
  return (
    <span className={cx("flex min-w-0 items-center gap-1.5 text-xs", node?.status === "waiting" ? "text-warn" : "text-muted")} data-testid="live-step">
      <span className="truncate">
        <span className="font-medium text-fg">{label}</span>
        {span && <> · {span} на шаге</>}
      </span>
    </span>
  );
}
