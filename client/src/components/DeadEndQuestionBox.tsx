import { useState } from "react";
import type { IssueNumber } from "../../../src/ids.js";
import { useAskAgent } from "../queries.js";
import { Badge, Button, cx, INPUT } from "./ui.js";

export type DeadEndQuestionBoxProps = {
  issueNumber: IssueNumber;
  // The Agent of the last step is running a Turn now: answering this question or the previous one.
  answering: boolean;
  // Called with the question once the server took it.
  onAsked?: (text: string) => void;
};

// The footer of the panel of a Task in a dead end: a question to the Agent of the last step. Its Session
// answers in one Turn into the feed above, the Task stays in the dead end.
export function DeadEndQuestionBox({ issueNumber, answering, onAsked }: DeadEndQuestionBoxProps) {
  const ask = useAskAgent(issueNumber);
  return (
    <DeadEndQuestionBoxView
      onAsk={(text, onSent) =>
        ask.mutate(text, {
          onSuccess: () => {
            onAsked?.(text);
            onSent();
          },
        })
      }
      sending={ask.isPending}
      answering={answering}
      error={ask.error?.message ?? null}
    />
  );
}

export type DeadEndQuestionBoxViewProps = {
  // `onSent` clears the field once the server took the question.
  onAsk: (text: string, onSent: () => void) => void;
  sending: boolean;
  answering: boolean;
  error: string | null;
};

export function DeadEndQuestionBoxView(props: DeadEndQuestionBoxViewProps) {
  const [text, setText] = useState("");
  const busy = props.sending || props.answering;
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    props.onAsk(trimmed, () => setText(""));
  };
  return (
    <div className="flex flex-col gap-2" data-testid="dead-end-question">
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
          aria-label="Вопрос Агенту"
          placeholder="Спросить Агента, что пошло не так (⌘/Ctrl+Enter): Задача останется в Тупике"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          }}
        />
        <Button type="submit" variant="primary" disabled={text.trim() === "" || busy}>
          Спросить
        </Button>
      </form>
      {busy && (
        <div className="flex items-center gap-2 text-xs text-muted" role="status">
          <Badge tone={props.answering ? "ok" : "neutral"} dot={props.answering} className="italic">
            {props.answering ? "Агент отвечает…" : "отправляется…"}
          </Badge>
          <span>ответ появится в ленте, после него процесс Агента снова остановится</span>
        </div>
      )}
      {props.error && (
        <div className="text-xs text-danger-text" role="alert">
          Вопрос не отправлен: {props.error}
        </div>
      )}
    </div>
  );
}
