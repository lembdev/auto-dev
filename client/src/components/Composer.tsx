import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Spinner, cx } from "./ui.js";

export type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  // Accessible names of the field and of the send button.
  label: string;
  submitLabel: string;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  autoFocus?: boolean;
  tone?: "neutral" | "warn";
  // A line under the field: what happens to the text once sent.
  hint?: ReactNode;
};

const MAX_HEIGHT = 240;

// The input of every chat in the UI: a field that grows with its text, Enter sends, Shift+Enter breaks
// the line, ⌘/Ctrl+Enter sends too. The round button on the right sends as well.
export function Composer({ value, onChange, onSubmit, label, submitLabel, placeholder, disabled = false, busy = false, autoFocus = false, tone = "neutral", hint }: ComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const empty = value.trim() === "";

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const submit = () => {
    if (empty || disabled) return;
    onSubmit();
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}>
      <div
        className={cx(
          "flex items-end gap-2 rounded-2xl border bg-surface py-1.5 pr-1.5 pl-3.5 shadow-[0_1px_3px_rgb(0_0_0/0.06)] transition-colors focus-within:ring-2",
          tone === "warn" ? "border-warn-line focus-within:ring-warn-line/30" : "border-line-strong focus-within:border-accent focus-within:ring-accent/20",
        )}>
        <textarea
          ref={field}
          className="max-h-60 min-h-[2rem] flex-1 resize-none self-center bg-transparent py-1 text-sm leading-relaxed text-fg outline-none placeholder:text-muted/70 focus-visible:outline-none"
          rows={1}
          aria-label={label}
          placeholder={placeholder}
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            if (event.shiftKey && !event.metaKey && !event.ctrlKey) return;
            event.preventDefault();
            submit();
          }}
        />
        <button
          type="submit"
          aria-label={submitLabel}
          title={`${submitLabel} (Enter)`}
          disabled={empty || disabled}
          className={cx(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none",
            empty || disabled ? "bg-subtle text-muted" : tone === "warn" ? "bg-warn text-white hover:brightness-110 dark:text-black" : "bg-accent text-accent-fg hover:bg-accent-hover",
          )}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <SendIcon />}
        </button>
      </div>
      {hint && <div className="px-3 text-[11px] text-muted">{hint}</div>}
    </form>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </svg>
  );
}
