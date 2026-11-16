import { useState } from "react";
import type { RequestView } from "../../../src/server/api-types.js";
import { Composer } from "./Composer.js";
import { MarkdownText } from "./MarkdownText.js";
import { cx, LINK } from "./ui.js";

export type RequestBlockProps = {
  request: RequestView;
  // True when the panel was opened by the "Ответить" button: the field gets the focus.
  autoFocus: boolean;
  onAnswer: (text: string) => void;
};

// The open Request above the input of the panel: the question, its options as chips that fill the
// field, the field itself. The Answer goes through the outbox; the block stays with the sent text
// until the `request` event tells the Session took it, then it disappears.
export function RequestBlock({ request, autoFocus, onAnswer }: RequestBlockProps) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    onAnswer(trimmed);
    setSent(trimmed);
    setText("");
  };
  return (
    <section className="overflow-hidden rounded-2xl border border-warn-line bg-warn-soft shadow-sm" aria-label="Запрос к человеку" data-testid="request-block">
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <QuestionMark />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs font-semibold text-warn">
            Запрос к человеку: Агент ждёт ответа
            {request.commentUrl && (
              <>
                <span className="font-normal text-muted">·</span>
                <a href={request.commentUrl} target="_blank" rel="noreferrer" className={cx(LINK, "font-normal")}>
                  комментарий в issue
                </a>
              </>
            )}
          </div>
          <div className="mt-1 text-[15px] leading-snug font-semibold break-words">
            {request.question ? <MarkdownText text={request.question} /> : "текст Запроса в комментарии issue"}
          </div>
        </div>
      </div>
      {request.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3.5 pt-2.5 pl-[2.875rem]" role="group" aria-label="Варианты ответа">
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={text === option}
              onClick={() => setText(option)}
              className={cx(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                text === option ? "border-accent bg-accent text-accent-fg" : "border-line-strong bg-surface text-fg hover:border-accent hover:text-link",
              )}>
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="px-2.5 pt-2.5 pb-2.5">
        {sent !== null && (
          <div className="mb-2 flex items-center justify-end gap-2 px-1 text-xs text-muted" role="status">
            <span className="animate-pulse">ответ отправлен, ждём, пока Агент его примет</span>
            <span className="max-w-[60%] truncate rounded-full bg-accent-soft px-2.5 py-0.5 text-fg ring-1 ring-accent/25">{sent}</span>
          </div>
        )}
        <Composer
          value={text}
          onChange={setText}
          onSubmit={submit}
          label="Ответ"
          submitLabel="Ответить"
          placeholder="Ваш ответ Агенту"
          autoFocus={autoFocus}
          tone="warn"
          hint="Enter: ответить · Shift+Enter: новая строка · ответ попадёт в Сессию и комментарием в issue"
        />
      </div>
    </section>
  );
}

function QuestionMark() {
  return (
    <span aria-hidden className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warn-line text-xs font-bold text-black">
      ?
    </span>
  );
}
