import { Fragment } from "react";
import { duration } from "../format.js";
import type { NodeStage, NodeStatus, Pipeline, PipelineEnd, PipelineNode } from "../pipeline.js";
import { cx } from "./ui.js";

export type PipelineStripProps = {
  pipeline: Pipeline;
  now: number;
  selectedKey: string | null;
  onSelect: (node: PipelineNode) => void;
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

const FRAME: Record<NodeStatus, string> = {
  ok: "border-line-strong bg-surface",
  rejected: "border-line-strong bg-surface",
  failed: "border-danger/50 bg-danger-soft",
  running: "border-accent bg-surface shadow-[0_0_0_3px_color-mix(in_oklab,var(--app-accent)_18%,transparent)]",
  waiting: "border-warn-line bg-warn-soft",
  idle: "border-accent/60 bg-surface",
  pending: "border-dashed border-line-strong bg-transparent opacity-60",
};

const ICON_TILE: Record<NodeStage, string> = {
  implement: "bg-accent-soft text-link",
  qa: "bg-ok-soft text-ok",
  merge: "bg-subtle text-fg",
};

const OUTCOME_TONE: Record<NodeStatus, string> = {
  ok: "text-ok",
  rejected: "text-warn",
  failed: "text-danger-text",
  running: "text-link",
  waiting: "text-warn",
  idle: "text-muted",
  pending: "text-muted",
};

function StageIcon({ stage }: { stage: NodeStage }) {
  const common = { "aria-hidden": true, viewBox: "0 0 16 16", className: "h-3.5 w-3.5", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
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

const live = (status: NodeStatus): boolean => status === "running" || status === "waiting" || status === "idle";

const spanOf = (node: PipelineNode, now: number): string | null =>
  node.startedAt ? duration((node.endedAt ? Date.parse(node.endedAt) : now) - Date.parse(node.startedAt)) : null;

// A finished node says how it ended, the live one how long it has been going; the full line is in the hint.
function subline(node: PipelineNode, now: number): string {
  const text = node.outcome ?? STATUS_TEXT[node.status];
  if (!live(node.status)) return text;
  const span = spanOf(node, now);
  return span ? `${text} · ${span}` : text;
}

function Node({ node, now, selected, onSelect }: { node: PipelineNode; now: number; selected: boolean; onSelect: (node: PipelineNode) => void }) {
  const clickable = node.status !== "pending" && node.agent !== null;
  const span = spanOf(node, now);
  const about = [node.title, node.outcome, span].filter(Boolean).join(" · ");
  const hint = node.status === "pending" ? "Шаг ещё впереди" : node.agent === null ? `${about}. Этот шаг делает сам Оркестратор, лога Агента нет` : `${about}. Открыть лог`;
  return (
    <button
      type="button"
      disabled={!clickable}
      title={hint}
      aria-pressed={clickable ? selected : undefined}
      data-testid={`node-${node.key}`}
      data-status={node.status}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node);
      }}
      className={cx(
        "relative flex min-w-[8.5rem] flex-1 basis-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-[border-color,box-shadow]",
        FRAME[node.status],
        clickable ? "cursor-pointer hover:border-accent" : "cursor-default",
        selected && "ring-2 ring-accent ring-offset-1 ring-offset-app",
      )}
    >
      <span className={cx("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", ICON_TILE[node.stage], node.status === "pending" && "bg-transparent text-muted")}>
        <StageIcon stage={node.stage} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-4 font-medium">{node.title}</span>
        <span className={cx("mt-0.5 flex items-center gap-1 truncate text-[11px] leading-4", OUTCOME_TONE[node.status])}>
          {live(node.status) && (
            <span aria-hidden className="relative flex h-1.5 w-1.5 shrink-0">
              {node.status === "running" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
            </span>
          )}
          <span className="truncate">{subline(node, now)}</span>
        </span>
      </span>
      {(node.status === "ok" || node.status === "rejected" || node.status === "failed") && (
        <span
          aria-hidden
          className={cx(
            "absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none font-bold text-white",
            node.status === "ok" ? "bg-ok dark:text-black" : node.status === "rejected" ? "bg-warn-line text-black" : "bg-danger",
          )}
        >
          {node.status === "ok" ? "✓" : "!"}
        </span>
      )}
    </button>
  );
}

function Connector({ pending }: { pending: boolean }) {
  return (
    <span aria-hidden className="flex w-5 shrink-0 items-center text-line-strong">
      <svg viewBox="0 0 24 10" className="h-2.5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M0 5h20" strokeDasharray={pending ? "3 3" : undefined} />
        <path d="m17 1.5 4 3.5-4 3.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const END_LOOK: Record<Exclude<PipelineEnd, null>, { text: string; className: string }> = {
  done: { text: "влито", className: "border-ok/40 bg-ok-soft text-ok" },
  stuck: { text: "тупик", className: "border-danger/40 bg-danger-soft text-danger-text" },
  cancelled: { text: "отменена", className: "border-line-strong text-muted" },
};

// The Pipeline of one Task as a row of nodes, left to right: each Agent step is its own node, the
// live one pulses, the steps ahead are dashed. A click opens that step's feed.
export function PipelineStrip({ pipeline, now, selectedKey, onSelect }: PipelineStripProps) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 pt-2 pb-1" data-testid="pipeline">
      <div className="flex min-w-max items-center sm:min-w-0">
        {pipeline.nodes.map((node, index) => (
          <Fragment key={node.key}>
            {index > 0 && <Connector pending={node.status === "pending"} />}
            <Node node={node} now={now} selected={selectedKey === node.key} onSelect={onSelect} />
          </Fragment>
        ))}
        {pipeline.end && (
          <>
            {pipeline.nodes.length > 0 && <Connector pending={false} />}
            <span className={cx("shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium", END_LOOK[pipeline.end].className)} data-testid="pipeline-end">
              {END_LOOK[pipeline.end].text}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
