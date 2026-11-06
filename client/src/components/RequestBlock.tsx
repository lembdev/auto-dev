import { useState } from "react";
import type { RequestView } from "../../../src/server/api-types.js";

export type RequestBlockProps = {
  request: RequestView;
  // True when the panel was opened by the "Ответить" button: the field gets the focus.
  autoFocus: boolean;
  onAnswer: (text: string) => void;
};

// The open Request at the top of the panel: the question, its options as buttons that fill the
// field, the field and "Ответить". The Answer goes through the outbox; the block disappears with the
// `request` event once the Session took it.
export function RequestBlock({ request, autoFocus, onAnswer }: RequestBlockProps) {
  const [text, setText] = useState("");
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    onAnswer(trimmed);
    setText("");
  };
  return (
    <form
      className="mx-3.5 mt-3 rounded-lg border border-wait-border bg-wait p-3 text-sm dark:border-wait-border-dark dark:bg-wait-dark"
      aria-label="Запрос к человеку"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="text-xs text-neutral-500">
        Запрос к человеку
        {request.commentUrl && (
          <>
            {" · "}
            <a href={request.commentUrl} target="_blank" rel="noreferrer" className="text-blue-600">
              комментарий в issue
            </a>
          </>
        )}
      </div>
      <div className="mt-1 whitespace-pre-wrap font-semibold">{request.question ?? "текст Запроса в комментарии issue"}</div>
      {request.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              onClick={() => setText(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <textarea
        className="mt-2 w-full rounded-md border border-neutral-300 bg-white p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        rows={2}
        aria-label="Ответ"
        placeholder="Ответ Агенту"
        autoFocus={autoFocus}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="submit" className="rounded-md bg-blue-600 px-2.5 py-0.5 text-xs text-white disabled:opacity-50" disabled={text.trim() === ""}>
          Ответить
        </button>
        <span className="text-xs text-neutral-500">Ответ попадёт в Сессию и комментарием в issue</span>
      </div>
    </form>
  );
}
