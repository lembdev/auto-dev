import { useState, type ReactNode } from "react";
import type { TaskView } from "../../../src/server/api-types.js";
import { useAgentFeed } from "../agent-feed.js";
import type { FeedState } from "../feed.js";
import { AGENT_LABELS, stageLabel } from "../format.js";
import { useCancelTask, useInterrupt } from "../queries.js";
import { AgentFeed } from "./AgentFeed.js";

export type AgentPanelProps = {
  task: TaskView;
  maxQaRounds: number;
  // True when opened by the "Ответить" button: the Request block gets the focus once it exists.
  answering: boolean;
  onClose: () => void;
  // The Request block above the feed and the Dialogue input in the footer; the panel leaves them room.
  requestSlot?: ReactNode;
  dialogueSlot?: ReactNode;
};

// The drawer of one Agent: the Session feed, then the buttons. Data and actions come from the hooks;
// `AgentPanelView` below is the part the tests render.
export function AgentPanel({ task, maxQaRounds, answering, onClose, requestSlot, dialogueSlot }: AgentPanelProps) {
  const feed = useAgentFeed(task.issueNumber, task.agent?.id ?? null);
  const interrupt = useInterrupt();
  const cancel = useCancelTask();
  return (
    <AgentPanelView
      task={task}
      maxQaRounds={maxQaRounds}
      answering={answering}
      onClose={onClose}
      feed={feed.feed}
      feedStatus={feed.status}
      feedError={feed.error}
      onInterrupt={() => interrupt.mutate(task.issueNumber)}
      interruptPending={interrupt.isPending}
      interruptError={interrupt.error?.message ?? null}
      onCancel={() => cancel.mutate(task.issueNumber, { onSuccess: onClose })}
      cancelPending={cancel.isPending}
      cancelError={cancel.error?.message ?? null}
      {...(requestSlot !== undefined ? { requestSlot } : {})}
      {...(dialogueSlot !== undefined ? { dialogueSlot } : {})}
    />
  );
}

export type AgentPanelViewProps = AgentPanelProps & {
  feed: FeedState;
  feedStatus: "loading" | "live" | "error";
  feedError: string | null;
  onInterrupt: () => void;
  interruptPending: boolean;
  interruptError: string | null;
  onCancel: () => void;
  cancelPending: boolean;
  cancelError: string | null;
};

export function AgentPanelView(props: AgentPanelViewProps) {
  const { task, maxQaRounds, answering, onClose } = props;
  const [confirming, setConfirming] = useState(false);
  const running = task.agent?.state === "running";

  return (
    <div className="flex h-full min-h-0 flex-col" role="dialog" aria-label={`Агент Задачи #${task.issueNumber}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-300 px-3.5 py-2.5 dark:border-neutral-700">
        <button type="button" className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700" onClick={onClose}>
          закрыть
        </button>
        <span className="font-semibold">
          #{task.issueNumber} {task.title}
        </span>
        <span className="rounded-full border border-neutral-300 px-2 py-px text-[11px] text-neutral-500 dark:border-neutral-700">{stageLabel(task, maxQaRounds)}</span>
        {task.agent && <span className="rounded-full border border-neutral-300 px-2 py-px text-[11px] text-neutral-500 dark:border-neutral-700">{AGENT_LABELS[task.agent.state]}</span>}
        {task.pullUrl && task.pullNumber !== null && (
          <a href={task.pullUrl} target="_blank" rel="noreferrer" className="text-blue-600">
            PR #{task.pullNumber}
          </a>
        )}
      </div>
      {props.requestSlot ??
        (answering && task.request && (
          <div className="mx-3.5 mt-3 rounded-lg border border-wait-border bg-wait p-3 text-sm dark:border-wait-border-dark dark:bg-wait-dark">
            <div className="text-xs text-neutral-500">
              Запрос к человеку
              {task.request.commentUrl && (
                <>
                  {" · "}
                  <a href={task.request.commentUrl} target="_blank" rel="noreferrer" className="text-blue-600">
                    комментарий в issue
                  </a>
                </>
              )}
            </div>
            <div className="mt-1 whitespace-pre-wrap font-semibold">{task.request.question ?? "текст Запроса в комментарии issue"}</div>
            {task.request.options.length > 0 && <div className="mt-1 text-xs text-neutral-500">Варианты: {task.request.options.join(" · ")}</div>}
            <div className="mt-2 text-xs text-neutral-500">Ответ из UI появится в следующем тикете; пока ответьте комментарием в issue.</div>
          </div>
        ))}
      <AgentFeed feed={props.feed} status={props.feedStatus} error={props.feedError} />
      <div className="flex flex-col gap-2 border-t border-neutral-300 px-3.5 py-2.5 text-sm dark:border-neutral-700">
        {props.dialogueSlot}
        {confirming && (
          <div className="rounded-md border border-red-300 bg-red-50 p-2.5 text-xs dark:border-red-800 dark:bg-red-950/40" data-testid="cancel-confirm">
            Отменить Задачу #{task.issueNumber}? Issue будет закрыта без влитого PR, Агент погашен, worktree и PR убраны.
            <div className="mt-2 flex gap-2">
              <button type="button" className="rounded-md bg-red-600 px-2 py-0.5 text-white disabled:opacity-50" disabled={props.cancelPending} onClick={() => props.onCancel()}>
                Да, отменить
              </button>
              <button type="button" className="rounded-md border border-neutral-300 px-2 py-0.5 dark:border-neutral-700" onClick={() => setConfirming(false)}>
                Нет
              </button>
            </div>
            {props.cancelError && (
              <div className="mt-1 text-red-600" role="alert">
                Не отменено: {props.cancelError}
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {running && (
            <button
              type="button"
              className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs disabled:opacity-50 dark:border-neutral-700"
              disabled={props.interruptPending}
              onClick={props.onInterrupt}
            >
              Остановить ход
            </button>
          )}
          <button
            type="button"
            className="rounded-md border border-red-300 px-2 py-0.5 text-xs text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
            disabled={confirming}
            onClick={() => setConfirming(true)}
          >
            Отменить задачу
          </button>
          <span className="flex-1" />
          {props.interruptError && (
            <span className="text-xs text-red-600" role="alert">
              Не остановлено: {props.interruptError}
            </span>
          )}
          <span className="text-xs text-neutral-500">Другого ручного управления нет</span>
        </div>
      </div>
    </div>
  );
}
