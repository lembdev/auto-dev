import { useMemo } from "react";
import type { FinishedTaskView, ReadyTaskView, StuckTaskView, TaskView } from "../../../src/server/api-types.js";
import { AGENT_LABELS, duration, elapsed, firstLine, stageLabel } from "../format.js";
import { focusNodeOf, pipelineOf, summaryOf } from "../pipeline.js";
import { LiveStep, PipelineStrip } from "./PipelineStrip.js";
import { Badge, Button, CARD, cx, LINK, type Tone } from "./ui.js";

const AGENT_TONE: Record<string, Tone> = {
  running: "ok",
  idle: "neutral",
  waiting: "warn",
  stopped: "neutral",
};

// The stripe on the left tells the cards apart at a glance: working, waiting for a human, resting.
const STRIPE: Record<string, string> = {
  running: "border-l-accent",
  waiting: "border-l-warn-line",
  idle: "border-l-line-strong",
  stopped: "border-l-line-strong",
};

export type TaskCardProps = {
  task: TaskView;
  maxQaRounds: number;
  now: number;
  // The node of this Task whose feed the panel shows, if the panel is on this Task.
  selectedKey: string | null;
  // Without a node the panel opens on the live step.
  onOpen: (task: TaskView, nodeKey?: string) => void;
  onAnswer: (task: TaskView) => void;
};

const milestoneOf = (task: { milestone: { title: string } | null }) => task.milestone?.title ?? "без milestone";

const Meta = ({ children }: { children: React.ReactNode }) => <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">{children}</div>;

const Dot = () => (
  <span aria-hidden className="text-line-strong">
    ·
  </span>
);

const IssueTitle = ({ task }: { task: { issueNumber: number; title: string } }) => (
  <>
    <span className="font-normal text-muted tabular-nums">#{task.issueNumber}</span> {task.title}
  </>
);

// A Task in the Pipeline: the row of its steps, each opening its own feed; a click elsewhere on the
// card opens the live step. The title is the keyboard target.
export function TaskCard({ task, maxQaRounds, now, selectedKey, onOpen, onAnswer }: TaskCardProps) {
  const waiting = task.agent?.state === "waiting";
  const pipeline = useMemo(() => pipelineOf(task), [task]);
  const question = task.request?.question ? firstLine(task.request.question) : null;
  return (
    <article
      data-testid={`task-${task.issueNumber}`}
      data-waiting={waiting}
      onClick={() => onOpen(task)}
      className={cx(
        CARD,
        "group cursor-pointer border-l-[3px] px-4 py-3 transition-colors",
        STRIPE[task.agent?.state ?? "running"],
        waiting ? "border-warn-line bg-warn-soft" : "hover:border-line-strong",
        selectedKey !== null && "border-accent/60",
      )}
    >
      <div className="flex items-start gap-3">
        <button type="button" className="min-w-0 flex-1 text-left font-semibold group-hover:text-link focus-visible:rounded-sm">
          <IssueTitle task={task} />
        </button>
        <span className="shrink-0 pt-0.5 text-xs text-muted tabular-nums" title={`взята ${task.takenAt}`}>
          {elapsed(task.takenAt, now)}
        </span>
      </div>
      <Meta>
        {task.agent ? (
          <Badge tone={AGENT_TONE[task.agent.state] ?? "neutral"} dot>
            {AGENT_LABELS[task.agent.state]}
          </Badge>
        ) : (
          <Badge dot>запускается</Badge>
        )}
        <span>{milestoneOf(task)}</span>
        {task.pullNumber !== null && (
          <>
            <Dot />
            {task.pullUrl ? (
              <a href={task.pullUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className={LINK}>
                PR #{task.pullNumber}
              </a>
            ) : (
              <span>PR #{task.pullNumber}</span>
            )}
          </>
        )}
      </Meta>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <PipelineStrip pipeline={pipeline} now={now} selectedKey={selectedKey} onSelect={(node) => onOpen(task, node.key)} />
        <LiveStep pipeline={pipeline} label={stageLabel(task, maxQaRounds)} now={now} />
      </div>
      {waiting && task.request && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-warn-line/70 bg-surface/70 py-1.5 pr-1.5 pl-3 text-[13px]">
          <span className="min-w-0 flex-1 truncate" data-testid="request-line">
            {question ?? "Запрос к человеку (текст в комментарии issue)"}
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onAnswer(task);
            }}
          >
            Ответить
          </Button>
        </div>
      )}
    </article>
  );
}

export function ReadyCard({ task }: { task: ReadyTaskView }) {
  return (
    <article data-testid={`ready-${task.issueNumber}`} className={cx(CARD, "px-4 py-3")}>
      <div className="font-semibold">
        <a href={task.htmlUrl} target="_blank" rel="noreferrer" className="text-inherit no-underline hover:text-link">
          <IssueTitle task={task} />
        </a>
      </div>
      <Meta>
        <Badge>готова, ждёт Слот</Badge>
        <span>{milestoneOf(task)}</span>
      </Meta>
    </article>
  );
}

export type FinishedCardProps<T> = {
  task: T;
  now: number;
  selectedKey?: string | null;
  onOpen?: (task: T, nodeKey: string) => void;
};

export function StuckCard(props: FinishedCardProps<StuckTaskView>) {
  const { task, now } = props;
  return (
    <article data-testid={`stuck-${task.issueNumber}`} className={cx(CARD, "border-l-[3px] border-l-danger px-4 py-3")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 font-semibold">
          {task.htmlUrl ? (
            <a href={task.htmlUrl} target="_blank" rel="noreferrer" className="text-inherit no-underline hover:text-link">
              <IssueTitle task={task} />
            </a>
          ) : (
            <IssueTitle task={task} />
          )}
        </div>
        {task.finishedAt && <span className="shrink-0 pt-0.5 text-xs text-muted tabular-nums">{elapsed(task.finishedAt, now)} назад</span>}
      </div>
      <Meta>
        <Badge tone="danger">ready-for-human</Badge>
        <span>{milestoneOf(task)}</span>
        {task.pullNumber !== null && task.pullUrl && (
          <>
            <Dot />
            <a href={task.pullUrl} target="_blank" rel="noreferrer" className={LINK}>
              PR #{task.pullNumber}
            </a>
          </>
        )}
      </Meta>
      <div className="mt-2 text-sm text-fg/80" data-testid="stuck-reason">
        {task.reason ?? "причина не записана"}
      </div>
      <StuckPipeline {...props} />
    </article>
  );
}

function StuckPipeline({ task, now, selectedKey = null, onOpen }: FinishedCardProps<StuckTaskView>) {
  const pipeline = useMemo(() => pipelineOf(task), [task]);
  if (pipeline.nodes.length === 0) return null;
  return (
    <div className="mt-2.5">
      <PipelineStrip pipeline={pipeline} now={now} selectedKey={selectedKey} onSelect={(node) => onOpen?.(task, node.key)} />
    </div>
  );
}

// A Task merged lately, as one row of a list: what it was, how it went, when it landed. The tiles of
// its steps stay small on the right; the row opens the last step's feed.
export function DoneCard({ task, now, selectedKey = null, onOpen }: FinishedCardProps<FinishedTaskView>) {
  const pipeline = useMemo(() => pipelineOf(task), [task]);
  const summary = summaryOf(pipeline);
  const took = task.finishedAt ? duration(Date.parse(task.finishedAt) - Date.parse(task.takenAt)) : null;
  const focus = focusNodeOf(pipeline);
  return (
    <li
      data-testid={`done-${task.issueNumber}`}
      onClick={() => focus && onOpen?.(task, focus.key)}
      className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 transition-colors sm:flex-nowrap", focus && onOpen && "cursor-pointer hover:bg-surface-2", selectedKey !== null && "bg-accent-soft")}
    >
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        <div className="truncate text-sm font-medium">
          {task.htmlUrl ? (
            <a href={task.htmlUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="text-inherit no-underline hover:text-link">
              <IssueTitle task={task} />
            </a>
          ) : (
            <IssueTitle task={task} />
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted" data-testid="done-summary">
          <span className="truncate">{milestoneOf(task)}</span>
          {task.pullNumber !== null && task.pullUrl && (
            <>
              <Dot />
              <a href={task.pullUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className={LINK}>
                PR #{task.pullNumber}
              </a>
            </>
          )}
          {summary && (
            <>
              <Dot />
              <span>{summary}</span>
            </>
          )}
          {took && (
            <>
              <Dot />
              <span>за {took}</span>
            </>
          )}
        </div>
      </div>
      {pipeline.nodes.length > 0 && <PipelineStrip pipeline={pipeline} now={now} selectedKey={selectedKey} onSelect={(node) => onOpen?.(task, node.key)} size="sm" />}
      {task.finishedAt && <span className="ml-auto w-24 shrink-0 text-right text-xs text-muted tabular-nums">{elapsed(task.finishedAt, now)} назад</span>}
    </li>
  );
}
