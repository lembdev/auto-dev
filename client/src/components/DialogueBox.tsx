import { useState } from "react";
import type { IssueNumber } from "../../../src/ids.js";
import type { DialogueMessageView } from "../../../src/server/api-types.js";
import { useDialogueOutbox, type DialogueOutboxHook, type LastAck, type OutboxFrame } from "../dialogue.js";
import { useDialogueQueue, useRemoveDialogueMessage } from "../queries.js";
import { Badge, Button, cx, INPUT } from "./ui.js";

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
        <ul className="flex flex-col gap-1 text-xs" aria-label="Ещё не доставлено">
          {props.pending.map((frame) => (
            <li key={`out-${frame.seq}`} className="flex items-start gap-2 text-muted">
              <Badge className="italic">отправляется…</Badge>
              <span className="whitespace-pre-wrap">{frame.text}</span>
            </li>
          ))}
          {props.queue.map((message) => (
            <li key={message.id} className="flex items-start gap-2 rounded-md bg-surface px-2 py-1 ring-1 ring-line">
              <Badge tone={message.source === "github" ? "accent" : "neutral"} className="mt-px">
                {message.source === "github" ? "из GitHub" : "ждёт конца Хода"}
              </Badge>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{message.text}</span>
              <button
                type="button"
                className="shrink-0 rounded px-1 text-danger-text hover:underline disabled:opacity-50"
                aria-label={`удалить сообщение ${message.id}`}
                disabled={props.removing === message.id}
                onClick={() => props.onRemove(message.id)}
              >
                удалить
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          className={cx(INPUT, "min-h-[2.75rem] flex-1 resize-y")}
          rows={2}
          aria-label="Сообщение Агенту"
          placeholder="Сообщение Агенту (⌘/Ctrl+Enter): во время Хода встанет в очередь"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          }}
        />
        <Button type="submit" variant="primary" disabled={text.trim() === ""}>
          Отправить
        </Button>
      </form>
      {props.lastAck && (
        <div className={`text-xs ${props.lastAck.ack.outcome === "rejected" ? "text-danger-text" : "text-muted"}`} role="status">
          {ackLabel(props.lastAck)}
        </div>
      )}
      {props.error && (
        <div className="text-xs text-danger-text" role="alert">
          Очередь Диалога: {props.error}
        </div>
      )}
    </div>
  );
}
