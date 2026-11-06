import type { ReadyTaskView, StuckTaskView, TaskView } from "../../../src/server/api-types.js";
import { AGENT_LABELS, elapsed, firstLine, stageLabel } from "../format.js";

const BADGE = "inline-block rounded-full border px-2 py-px text-[11px]";
const AGENT_BADGE: Record<string, string> = {
  running: "border-green-600 text-green-700 dark:text-green-400",
  idle: "border-neutral-400 text-neutral-500",
  waiting: "border-amber-500 text-amber-700 dark:text-amber-400",
  stopped: "border-neutral-400 text-neutral-500",
};

export type TaskCardProps = {
  task: TaskView;
  maxQaRounds: number;
  now: number;
  selected: boolean;
  onOpen: (task: TaskView) => void;
  onAnswer: (task: TaskView) => void;
};

const CARD = "rounded-lg border bg-white p-3 dark:bg-neutral-900";

const milestoneOf = (task: { milestone: { title: string } | null }) => task.milestone?.title ?? "без milestone";

export function TaskCard({ task, maxQaRounds, now, selected, onOpen, onAnswer }: TaskCardProps) {
  const waiting = task.agent?.state === "waiting";
  const question = task.request?.question ? firstLine(task.request.question) : null;
  return (
    <article
      data-testid={`task-${task.issueNumber}`}
      data-waiting={waiting}
      onClick={() => onOpen(task)}
      className={`${CARD} cursor-pointer hover:border-blue-600 ${
        waiting ? "border-wait-border bg-wait dark:border-wait-border-dark dark:bg-wait-dark" : "border-neutral-300 dark:border-neutral-700"
      } ${selected ? "outline-2 outline-blue-600" : ""}`}
    >
      <div className="font-semibold">
        #{task.issueNumber} {task.title}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span>{milestoneOf(task)}</span>
        <span>{stageLabel(task, maxQaRounds)}</span>
        {task.agent ? (
          <span className={`${BADGE} ${AGENT_BADGE[task.agent.state]}`}>{AGENT_LABELS[task.agent.state]}</span>
        ) : (
          <span className={`${BADGE} border-neutral-400`}>запускается</span>
        )}
        {task.pullNumber !== null &&
          (task.pullUrl ? (
            <a href={task.pullUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="text-blue-600">
              PR #{task.pullNumber}
            </a>
          ) : (
            <span>PR #{task.pullNumber}</span>
          ))}
        <span title={`взята ${task.takenAt}`}>{elapsed(task.takenAt, now)}</span>
      </div>
      {waiting && task.request && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-wait-border bg-white/60 px-2 py-1.5 text-[13px] dark:border-wait-border-dark dark:bg-black/20">
          <span className="flex-1 truncate" data-testid="request-line">
            {question ?? "Запрос к человеку (текст в комментарии issue)"}
          </span>
          <button
            type="button"
            className="rounded-md bg-blue-600 px-2 py-0.5 text-xs text-white"
            onClick={(event) => {
              event.stopPropagation();
              onAnswer(task);
            }}
          >
            Ответить
          </button>
        </div>
      )}
    </article>
  );
}

export function ReadyCard({ task }: { task: ReadyTaskView }) {
  return (
    <article data-testid={`ready-${task.issueNumber}`} className={`${CARD} border-neutral-300 dark:border-neutral-700`}>
      <div className="font-semibold">
        <a href={task.htmlUrl} target="_blank" rel="noreferrer" className="text-inherit no-underline hover:underline">
          #{task.issueNumber} {task.title}
        </a>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-neutral-500">
        <span>{milestoneOf(task)}</span>
        <span className={`${BADGE} border-neutral-400`}>готова, ждёт Слот</span>
      </div>
    </article>
  );
}

export function StuckCard({ task, now }: { task: StuckTaskView; now: number }) {
  return (
    <article data-testid={`stuck-${task.issueNumber}`} className={`${CARD} border-neutral-300 dark:border-neutral-700`}>
      <div className="font-semibold">
        {task.htmlUrl ? (
          <a href={task.htmlUrl} target="_blank" rel="noreferrer" className="text-inherit no-underline hover:underline">
            #{task.issueNumber} {task.title}
          </a>
        ) : (
          <>
            #{task.issueNumber} {task.title}
          </>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-neutral-500">
        <span>{milestoneOf(task)}</span>
        <span className={`${BADGE} border-red-600 text-red-600 dark:text-red-400`}>ready-for-human</span>
        {task.pullNumber !== null && task.pullUrl && (
          <a href={task.pullUrl} target="_blank" rel="noreferrer" className="text-blue-600">
            PR #{task.pullNumber}
          </a>
        )}
        {task.finishedAt && <span>{elapsed(task.finishedAt, now)} назад</span>}
      </div>
      <div className="mt-1 text-xs text-neutral-500" data-testid="stuck-reason">
        {task.reason ?? "причина не записана"}
      </div>
    </article>
  );
}
