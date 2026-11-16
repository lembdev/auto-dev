import { useState } from "react";
import type { IssueNumber } from "../../../src/ids.js";
import type { DialogueMessageView } from "../../../src/server/api-types.js";
import { useDialogueOutbox, type DialogueOutboxHook, type LastAck, type OutboxFrame } from "../dialogue.js";
import { useDialogueQueue, useRemoveDialogueMessage } from "../queries.js";
import { Composer } from "./Composer.js";
import { Badge, cx } from "./ui.js";

export type DialogueBoxProps = { issueNumber: IssueNumber; outbox: DialogueOutboxHook };

// The footer of the panel: lines not yet in the Session (unconfirmed by the server, then queued),
// the field and "Отправить". A line typed during a Turn waits here for the end of the Turn.
export function DialogueBox({ issueNumber, outbox }: DialogueBoxProps) {
  const queue = useDialogueQueue(issueNumber);
  const remove = useRemoveDialogueMessage(issueNumber);
  return (
    <DialogueBoxView
      queue={queue.data?.messages ?? []}
      pending={outbox.pending}
      lastAck={outbox.lastAck}
      onSend={(text) => outbox.send({ kind: "dialogue", issueNumber }, text)}
      onRemove={(id) => remove.mutate(id)}
      removing={remove.isPending ? (remove.variables ?? null) : null}
      error={queue.error?.message ?? remove.error?.message ?? null}
    />
  );
}

// A line of a Dialogue queue: of a Task's Dialogue or of the Dialogue with the Planner.
// `Id` is the id of a queued line: a pending message of a Task or a line to the Planner.
export type DialogueQueueLine<Id extends number> = Pick<DialogueMessageView, "text" | "source"> & { id: Id };

export type DialogueBoxViewProps<Id extends number> = {
  queue: DialogueQueueLine<Id>[];
  pending: OutboxFrame[];
  lastAck: LastAck | null;
  onSend: (text: string) => void;
  onRemove: (id: Id) => void;
  removing: Id | null;
  error: string | null;
};

// What the server said about the last frame of this Task, in the human's words.
export const ackLabel = ({ frame, ack }: LastAck): string => {
  const what = frame.kind === "answer" ? "Ответ" : "Сообщение";
  switch (ack.outcome) {
    case "applied":
      return frame.kind === "answer" ? "Ответ принят" : "Сообщение принято";
    case "duplicate":
      return `${what} уже принято ранее`;
    case "rejected":
      return `${what} отклонено: ${ack.reason ?? "без причины"}`;
  }
};

export function DialogueBoxView<Id extends number>(props: DialogueBoxViewProps<Id>) {
  const [text, setText] = useState("");
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    props.onSend(trimmed);
    setText("");
  };
  const waiting = props.pending.length + props.queue.length;
  return (
    <div className="flex flex-col gap-2" data-testid="dialogue">
      {waiting > 0 && (
        <ul className="flex flex-col items-end gap-1.5" aria-label="Ещё не доставлено">
          {props.pending.map((frame) => (
            <li key={`out-${frame.seq}`} className="flex max-w-[85%] flex-col items-end gap-0.5">
              <span className="rounded-2xl rounded-br-md bg-accent-soft px-3 py-1.5 text-sm break-words whitespace-pre-wrap opacity-70 ring-1 ring-accent/25">{frame.text}</span>
              <span className="flex items-center gap-1.5 px-1 text-[11px] text-muted italic">
                <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {frame.kind === "answer" ? "ответ " : ""}отправляется…
              </span>
            </li>
          ))}
          {props.queue.map((message) => (
            <li key={message.id} className="flex max-w-[85%] flex-col items-end gap-0.5">
              <span className="rounded-2xl rounded-br-md border border-dashed border-accent/40 bg-surface px-3 py-1.5 text-sm break-words whitespace-pre-wrap">{message.text}</span>
              <span className="flex items-center gap-2 px-1 text-[11px] text-muted">
                <Badge tone={message.source === "github" ? "accent" : "neutral"}>{message.source === "github" ? "из GitHub" : "ждёт конца Хода"}</Badge>
                <button
                  type="button"
                  className="rounded px-1 text-danger-text hover:underline disabled:opacity-50"
                  aria-label={`удалить сообщение ${message.id}`}
                  disabled={props.removing === message.id}
                  onClick={() => props.onRemove(message.id)}>
                  удалить
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Composer
        value={text}
        onChange={setText}
        onSubmit={submit}
        label="Сообщение Агенту"
        submitLabel="Отправить"
        placeholder="Написать Агенту…"
        hint="Enter: отправить · Shift+Enter: новая строка · во время Хода сообщение встанет в очередь"
      />
      {props.lastAck && (
        <div className={cx("px-3 text-xs", props.lastAck.ack.outcome === "rejected" ? "text-danger-text" : "text-muted")} role="status">
          {ackLabel(props.lastAck)}
        </div>
      )}
      {props.error && (
        <div className="px-3 text-xs text-danger-text" role="alert">
          Очередь Диалога: {props.error}
        </div>
      )}
    </div>
  );
}
