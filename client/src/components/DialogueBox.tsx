import { useState } from "react";
import type { DialogueMessageView } from "../../../src/server/api-types.js";
import { useDialogueOutbox, type DialogueOutboxHook, type LastAck, type OutboxFrame } from "../dialogue.js";
import { useDialogueQueue, useRemoveDialogueMessage } from "../queries.js";

export type DialogueBoxProps = { issueNumber: number; outbox: DialogueOutboxHook };

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

export type DialogueBoxViewProps = {
  queue: DialogueMessageView[];
  pending: OutboxFrame[];
  lastAck: LastAck | null;
  onSend: (text: string) => void;
  onRemove: (id: number) => void;
  removing: number | null;
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

export function DialogueBoxView(props: DialogueBoxViewProps) {
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
            <li key={`out-${frame.seq}`} className="flex items-start gap-2 text-neutral-500">
              <span className="shrink-0 italic">отправляется…</span>
              <span className="whitespace-pre-wrap">{frame.text}</span>
            </li>
          ))}
          {props.queue.map((message) => (
            <li key={message.id} className="flex items-start gap-2">
              <span className="shrink-0 rounded-full border border-neutral-300 px-1.5 text-[11px] text-neutral-500 dark:border-neutral-700">
                {message.source === "github" ? "из GitHub" : "ждёт конца Хода"}
              </span>
              <span className="flex-1 whitespace-pre-wrap">{message.text}</span>
              <button
                type="button"
                className="shrink-0 text-red-600 disabled:opacity-50"
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
          className="flex-1 rounded-md border border-neutral-300 bg-white p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          rows={2}
          aria-label="Сообщение Агенту"
          placeholder="Сообщение Агенту: во время Хода встанет в очередь"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          }}
        />
        <button type="submit" className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs disabled:opacity-50 dark:border-neutral-700" disabled={text.trim() === ""}>
          Отправить
        </button>
      </form>
      {props.lastAck && (
        <div className={`text-xs ${props.lastAck.ack.outcome === "rejected" ? "text-red-600" : "text-neutral-500"}`} role="status">
          {ackLabel(props.lastAck)}
        </div>
      )}
      {props.error && (
        <div className="text-xs text-red-600" role="alert">
          Очередь Диалога: {props.error}
        </div>
      )}
    </div>
  );
}
