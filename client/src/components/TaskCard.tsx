import { useMemo } from "react";
import type { FinishedTaskView, ReadyTaskView, StuckTaskView, TaskView } from "../../../src/server/api-types.js";
import { AGENT_LABELS, elapsed, firstLine, stageLabel } from "../format.js";
import { pipelineOf } from "../pipeline.js";
import { PipelineStrip } from "./PipelineStrip.js";
import { Badge, Button, CARD, cx, LINK, type Tone } from "./ui.js";

const AGENT_TONE: Record<string, Tone> = {
  running: "ok",
  idle: "neutral",
  waiting: "warn",
  stopped: "neutral",
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
        "group cursor-pointer px-4 py-3 transition-colors",
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
        <span className="font-medium text-fg">{stageLabel(task, maxQaRounds)}</span>
        <Dot />
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
      <PipelineStrip pipeline={pipeline} now={now} selectedKey={selectedKey} onSelect={(node) => onOpen(task, node.key)} />
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

function FinishedPipeline<T extends FinishedTaskView>({ task, now, selectedKey = null, onOpen }: FinishedCardProps<T>) {
  const pipeline = useMemo(() => pipelineOf(task), [task]);
  if (pipeline.nodes.length === 0) return null;
  return <PipelineStrip pipeline={pipeline} now={now} selectedKey={selectedKey} onSelect={(node) => onOpen?.(task, node.key)} />;
}

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
      <FinishedPipeline {...props} />
    </article>
  );
}

// A Task merged lately: kept on the board for a while so its steps can still be read.
export function DoneCard(props: FinishedCardProps<FinishedTaskView>) {
  const { task, now } = props;
  return (
    <article data-testid={`done-${task.issueNumber}`} className={cx(CARD, "px-4 py-3", props.selectedKey == null && "opacity-80 hover:opacity-100")}>
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
      <FinishedPipeline {...props} />
    </article>
  );
}
