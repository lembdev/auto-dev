import { useState } from "react";
import type { RequestView } from "../../../src/server/api-types.js";
import { Button, cx, INPUT, LINK } from "./ui.js";

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
      className="mx-4 mt-3 rounded-xl border border-warn-line bg-warn-soft p-3.5 text-sm"
      aria-label="Запрос к человеку"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-warn">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warn-line" />
        Запрос к человеку
        {request.commentUrl && (
          <>
            {" · "}
            <a href={request.commentUrl} target="_blank" rel="noreferrer" className={cx(LINK, "font-normal")}>
              комментарий в issue
            </a>
          </>
        )}
      </div>
      <div className="mt-1.5 font-semibold whitespace-pre-wrap">{request.question ?? "текст Запроса в комментарии issue"}</div>
      {request.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.options.map((option) => (
            <Button key={option} size="sm" aria-pressed={text === option} className={text === option ? "border-accent text-link" : undefined} onClick={() => setText(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      <textarea
        className={cx(INPUT, "mt-2.5 block resize-y")}
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
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="submit" variant="primary" size="sm" disabled={text.trim() === ""}>
          Ответить
        </Button>
        <span className="text-xs text-muted">Ответ попадёт в Сессию и комментарием в issue · ⌘/Ctrl+Enter</span>
      </div>
    </form>
  );
}
