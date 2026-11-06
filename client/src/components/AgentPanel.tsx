import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskView } from "../../../src/server/api-types.js";
import { useAgentFeed } from "../agent-feed.js";
import { useDialogueOutbox } from "../dialogue.js";
import type { FeedState } from "../feed.js";
import { AGENT_LABELS, stageLabel } from "../format.js";
import { useCancelTask, useInterrupt } from "../queries.js";
import { AgentFeed } from "./AgentFeed.js";
import { DialogueBox } from "./DialogueBox.js";
import { RequestBlock } from "./RequestBlock.js";
import { Badge, Button, CloseIcon, LINK } from "./ui.js";

export type AgentPanelProps = {
  task: TaskView;
  maxQaRounds: number;
  // True when opened by the "Ответить" button: the Request block gets the focus once it exists.
  answering: boolean;
  onClose: () => void;
  // The Request block above the feed and the Dialogue input in the footer; by default the open
  // Request of the Task and its Dialogue, both over the outbox of the tab.
  requestSlot?: ReactNode;
  dialogueSlot?: ReactNode;
};

// The drawer of one Agent: the Request if there is one, the Session feed, the Dialogue, the buttons.
// Data and actions come from the hooks; `AgentPanelView` below is the part the tests render.
export function AgentPanel({ task, maxQaRounds, answering, onClose, requestSlot, dialogueSlot }: AgentPanelProps) {
  const feed = useAgentFeed(task.issueNumber, task.agent?.id ?? null);
  const interrupt = useInterrupt();
  const cancel = useCancelTask();
  const outbox = useDialogueOutbox(task.issueNumber);
  const request = task.request;
  const requestBlock =
    requestSlot ??
    (request ? (
      <RequestBlock
        key={request.id}
        request={request}
        autoFocus={answering}
        onAnswer={(text) => outbox.send({ kind: "answer", issueNumber: task.issueNumber, requestId: request.id }, text)}
      />
    ) : undefined);
  const dialogueBox = dialogueSlot ?? <DialogueBox issueNumber={task.issueNumber} outbox={outbox} />;
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
      {...(requestBlock !== undefined ? { requestSlot: requestBlock } : {})}
      dialogueSlot={dialogueBox}
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
  const { task, maxQaRounds, onClose } = props;
  const [confirming, setConfirming] = useState(false);
  const running = task.agent?.state === "running";
  const dialogRef = useRef<HTMLDivElement>(null);
  // The drawer takes the focus when it opens (Tab then walks its controls), unless the Request field asked for it.
  useEffect(() => {
    if (!props.answering) dialogRef.current?.focus();
  }, [props.answering]);

  return (
    <div ref={dialogRef} tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none" role="dialog" aria-modal="true" aria-label={`Агент Задачи #${task.issueNumber}`}>
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            <span className="font-normal text-muted tabular-nums">#{task.issueNumber}</span> {task.title}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="accent">{stageLabel(task, maxQaRounds)}</Badge>
            {task.agent && (
              <Badge tone={task.agent.state === "running" ? "ok" : task.agent.state === "waiting" ? "warn" : "neutral"} dot>
                {AGENT_LABELS[task.agent.state]}
              </Badge>
            )}
            {task.pullUrl && task.pullNumber !== null && (
              <a href={task.pullUrl} target="_blank" rel="noreferrer" className={LINK}>
                PR #{task.pullNumber}
              </a>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" className="-mr-1.5 h-8 w-8 px-0" aria-label="Закрыть" title="Закрыть (Esc)" onClick={onClose}>
          <CloseIcon />
        </Button>
      </div>
      {props.requestSlot}
      <AgentFeed feed={props.feed} status={props.feedStatus} error={props.feedError} />
      <div className="flex flex-col gap-2.5 border-t border-line bg-surface-2/60 px-4 py-3 text-sm">
        {props.dialogueSlot}
        {confirming && (
          <div className="rounded-lg border border-danger/50 bg-danger-soft p-3 text-xs" data-testid="cancel-confirm" role="alertdialog" aria-label="Отмена Задачи">
            Отменить Задачу #{task.issueNumber}? Issue будет закрыта без влитого PR, Агент погашен, worktree и PR убраны.
            <div className="mt-2.5 flex gap-2">
              <Button variant="danger-solid" size="sm" disabled={props.cancelPending} onClick={() => props.onCancel()}>
                Да, отменить
              </Button>
              <Button size="sm" onClick={() => setConfirming(false)}>
                Нет
              </Button>
            </div>
            {props.cancelError && (
              <div className="mt-1.5 text-danger-text" role="alert">
                Не отменено: {props.cancelError}
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {running && (
            <Button size="sm" disabled={props.interruptPending} onClick={props.onInterrupt}>
              Остановить ход
            </Button>
          )}
          <Button variant="danger" size="sm" disabled={confirming} onClick={() => setConfirming(true)}>
            Отменить задачу
          </Button>
          <span className="flex-1" />
          {props.interruptError && (
            <span className="text-xs text-danger-text" role="alert">
              Не остановлено: {props.interruptError}
            </span>
          )}
          <span className="text-xs text-muted">Другого ручного управления нет</span>
        </div>
      </div>
    </div>
  );
}
