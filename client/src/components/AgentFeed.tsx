import { useEffect, useRef, useState, type ReactNode } from "react";
import { splitVerdict, type Verdict } from "../../../src/orchestrator/verdict.js";
import { MarkdownText } from "./MarkdownText.js";
import { LINK, Spinner, cx } from "./ui.js";
import {
  askHumanOf,
  childrenOf,
  formatInput,
  isAskHumanTool,
  toolHead,
  topLevelOf,
  type AnswerSource,
  type AskHumanView,
  type FeedItem,
  type FeedState,
  type SystemItem,
  type ThinkingItem,
  type ToolItem,
} from "../feed.js";

export type AgentFeedProps = {
  feed: FeedState;
  status: "loading" | "live" | "error";
  error: string | null;
  // The Agent is running a Turn: the feed ends with a "working" line while nothing streams.
  working?: boolean;
};

// The panel reads as a chat: the Agent's prose on the left, the human's messages and Answers as bubbles
// on the right, questions to the human as cards of their own, and between them the steps the Agent
// took, gathered into one foldable group per run of tool calls and thoughts.
export function AgentFeed({ feed, status, error, working = false }: AgentFeedProps) {
  const container = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [detached, setDetached] = useState(false);
  const count = feed.items.length;

  useEffect(() => {
    const element = container.current;
    if (!element || !stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [count, feed, working]);

  const onScroll = () => {
    const element = container.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    setDetached(!stickToBottom.current);
  };

  const toBottom = () => {
    const element = container.current;
    if (!element) return;
    stickToBottom.current = true;
    setDetached(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const top = topLevelOf(feed.items);
  const first = top[0];
  const prompt = first?.kind === "user" ? first : undefined;
  const rest = prompt ? top.slice(1) : top;
  const streaming = feed.items.some((item) => (item.kind === "text" || item.kind === "thinking" || item.kind === "tool") && item.streaming);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={container} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto" data-testid="agent-feed" data-status={status}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
          {status === "loading" && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Spinner className="h-3 w-3" /> Загрузка истории Сессии…
            </div>
          )}
          {status === "error" && (
            <div className="text-xs text-danger-text" role="alert">
              История не загружена: {error}
            </div>
          )}
          {status === "live" && count === 0 && !working && <div className="py-10 text-center text-sm text-muted">Сессия пока пуста.</div>}
          {prompt && <LaunchPrompt text={prompt.text} />}
          <FeedList items={rest} all={feed.items} live={working} />
          {working && !streaming && <WorkingRow />}
        </div>
      </div>
      {detached && (
        <button
          type="button"
          onClick={toBottom}
          aria-label="К последним сообщениям"
          className="absolute bottom-3 left-1/2 inline-flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-line-strong bg-surface text-muted shadow-md hover:text-fg">
          <ChevronIcon className="h-4 w-4 rotate-90" />
        </button>
      )}
    </div>
  );
}

function WorkingRow() {
  return (
    <div className="flex items-center gap-2.5 text-xs text-muted" data-testid="feed-working" role="status">
      <AgentAvatar />
      <span className="inline-flex gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
      </span>
      Агент работает…
    </div>
  );
}

function AgentAvatar() {
  return (
    <span aria-hidden className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent ring-1 ring-accent/25">
      <AgentIcon className="h-3.5 w-3.5" />
    </span>
  );
}

// Steps: tool calls that are not subagents nor questions to the human, and thoughts with something to
// read. A thought the model kept to itself (an empty block with only a signature) has nothing to show.
type Step = ToolItem | ThinkingItem;
type Segment = { kind: "steps"; id: string; steps: Step[] } | { kind: "item"; item: FeedItem };

const isStep = (item: FeedItem, all: FeedItem[]): item is Step =>
  (item.kind === "tool" && item.subagent === null && !isAskHumanTool(item.name) && childrenOf(all, item.id).length === 0) || item.kind === "thinking";

const isSilentThought = (item: FeedItem): boolean => item.kind === "thinking" && item.text.trim() === "" && !item.streaming;

function segmentsOf(items: FeedItem[], all: FeedItem[]): Segment[] {
  const segments: Segment[] = [];
  for (const item of items) {
    if (isSilentThought(item)) continue;
    if (isStep(item, all)) {
      const last = segments.at(-1);
      if (last?.kind === "steps") last.steps.push(item);
      else segments.push({ kind: "steps", id: item.id, steps: [item] });
    } else {
      segments.push({ kind: "item", item });
    }
  }
  return segments;
}

function FeedList({ items, all, live = false }: { items: FeedItem[]; all: FeedItem[]; live?: boolean }) {
  const segments = segmentsOf(items, all);
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === "steps" ? (
          <StepGroup key={segment.id} steps={segment.steps} current={live && i === segments.length - 1} />
        ) : (
          <FeedRow key={segment.item.id} item={segment.item} all={all} />
        ),
      )}
    </>
  );
}

function FeedRow({ item, all }: { item: FeedItem; all: FeedItem[] }) {
  switch (item.kind) {
    case "text": {
      const split = item.streaming ? undefined : splitVerdict(item.text);
      if (split) {
        return (
          <>
            {split.rest !== "" && (
              <div className="text-[14.5px] leading-relaxed break-words" data-testid="feed-text" data-streaming={false}>
                <MarkdownText text={split.rest} />
              </div>
            )}
            <VerdictCard verdict={split.verdict} />
          </>
        );
      }
      return (
        <div className="text-[14.5px] leading-relaxed break-words" data-testid="feed-text" data-streaming={item.streaming}>
          <MarkdownText text={item.text} />
          {item.streaming && <span className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-pulse rounded-sm bg-accent" />}
        </div>
      );
    }
    case "user":
      return <HumanBubble text={item.text} />;
    case "system":
      return <SystemRow item={item} />;
    case "tool": {
      const ask = askHumanOf(item);
      return ask ? <AskHumanCard item={item} ask={ask} /> : <SubagentBlock item={item} all={all} />;
    }
    case "thinking":
      return <StepGroup steps={[item]} current={false} />;
  }
}

// A message of the human: a bubble on the right with who wrote it above.
function HumanBubble({ text, label = "Вы", meta, testId = "feed-user" }: { text: string; label?: ReactNode; meta?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col items-end gap-1 pl-10" data-testid={testId}>
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted">
        {label}
        {meta}
      </div>
      <div className="max-w-full rounded-2xl rounded-tr-md bg-accent px-3.5 py-2 text-[14.5px] leading-relaxed break-words text-accent-fg shadow-sm [&_a]:text-accent-fg [&_blockquote]:border-accent-fg/40 [&_blockquote]:text-accent-fg/80 [&_code]:bg-black/15 [&_pre]:border-accent-fg/20 [&_pre]:bg-black/15">
        <MarkdownText text={text} />
      </div>
    </div>
  );
}

const sourceLabel = (source: AnswerSource | null): ReactNode => {
  if (!source || source.kind === "ui") return null;
  if (source.kind === "github")
    return (
      <>
        <span>·</span>
        <a href={source.url} target="_blank" rel="noreferrer" className={LINK}>
          @{source.author} в GitHub
        </a>
      </>
    );
  return (
    <>
      <span>·</span>
      <span className="truncate">{source.text}</span>
    </>
  );
};

// A question to the human through `ask_human`: a card with the question and its options, then the
// Answer as the human's bubble, or a line saying the Agent waits for it.
function AskHumanCard({ item, ask }: { item: ToolItem; ask: AskHumanView }) {
  const answered = ask.answer !== null;
  const failed = item.isError;
  return (
    <div className="flex flex-col gap-3" data-testid="feed-ask" data-answered={answered}>
      <div className={cx("rounded-2xl border px-3.5 py-3", answered ? "border-line bg-surface-2" : failed ? "border-danger/40 bg-danger-soft" : "border-warn-line bg-warn-soft")}>
        <div className={cx("flex items-center gap-2 text-xs font-semibold", answered ? "text-muted" : failed ? "text-danger-text" : "text-warn")}>
          <span aria-hidden className={cx("inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold", answered ? "bg-subtle text-muted" : "bg-warn-line text-black")}>
            ?
          </span>
          Агент спрашивает
          {!answered && !failed && (
            <span className="ml-auto inline-flex items-center gap-1.5 font-medium">
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn-line" />
              ждёт ответа
            </span>
          )}
          {answered && <span className="ml-auto font-medium text-ok">✓ отвечено</span>}
        </div>
        <div className="mt-1.5 text-[14.5px] leading-snug font-semibold break-words" data-testid="feed-ask-question">
          {ask.question ? <MarkdownText text={ask.question} /> : <span className="font-normal text-muted italic">{item.streaming ? "Агент формулирует вопрос…" : "текст вопроса в комментарии issue"}</span>}
        </div>
        {ask.options.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {ask.options.map((option) => {
              const chosen = ask.answer !== null && ask.answer.trim() === option.trim();
              return (
                <span key={option} className={cx("rounded-full border px-2.5 py-0.5 text-xs", chosen ? "border-accent bg-accent text-accent-fg" : "border-line-strong bg-surface text-muted")}>
                  {option}
                </span>
              );
            })}
          </div>
        )}
        {failed && item.result && <div className="mt-2 text-xs text-danger-text">{cleanResult(item.result)}</div>}
      </div>
      {answered && <HumanBubble text={ask.answer ?? ""} label="Ответ" meta={sourceLabel(ask.source)} testId="feed-answer" />}
    </div>
  );
}

function SystemRow({ item }: { item: SystemItem }) {
  const warn = item.level === "warn";
  return (
    <div className="flex items-center gap-3 text-[11px]" data-testid="feed-system" data-level={item.level}>
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span className={cx("max-w-[80%] rounded-full px-2.5 py-0.5 text-center break-words", warn ? "bg-warn-soft text-warn ring-1 ring-warn-line/50" : "text-muted")}>{item.text}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

// A long run of steps keeps only its tail in view; the earlier ones fold behind one line.
const VISIBLE_TAIL = 5;

const stepRunning = (step: Step): boolean => step.streaming || (step.kind === "tool" && step.result === null);

// One run of steps: a line that names how many and which tools, unfolding into the steps themselves.
// The run the Agent is in right now stays open; the finished ones fold so the prose reads on.
function StepGroup({ steps, current }: { steps: Step[]; current: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const isOpen = open ?? current;
  const hidden = expanded || steps.length <= VISIBLE_TAIL + 1 ? 0 : steps.length - VISIBLE_TAIL;
  const shown = steps.slice(hidden);
  const running = steps.some(stepRunning);
  const failed = steps.filter((step) => step.kind === "tool" && step.isError).length;
  const tools = steps.filter((step): step is ToolItem => step.kind === "tool");
  const names = [...new Set(tools.map((tool) => tool.name))];
  const thoughts = steps.length - tools.length;
  const title =
    tools.length > 0
      ? `${tools.length} ${plural(tools.length, "действие", "действия", "действий")}${thoughts > 0 ? ` и ${thoughts} ${plural(thoughts, "размышление", "размышления", "размышлений")}` : ""}`
      : `${thoughts} ${plural(thoughts, "размышление", "размышления", "размышлений")}`;
  const last = steps.at(-1);
  return (
    <details
      open={isOpen}
      className="group/steps overflow-hidden rounded-xl border border-line bg-surface-2/50"
      data-testid="feed-steps"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex min-w-0 list-none items-center gap-2 px-3 py-2 text-xs text-muted select-none hover:bg-subtle hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="h-3 w-3 shrink-0 transition-transform group-open/steps:rotate-90" />
        {running ? <Spinner className="h-3 w-3 shrink-0 text-accent" /> : <StepsIcon className="h-3.5 w-3.5 shrink-0" />}
        <span className="shrink-0 font-medium text-fg">{title}</span>
        {failed > 0 && <span className="shrink-0 rounded-full bg-danger-soft px-1.5 text-danger-text">ошибок: {failed}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {running && last?.kind === "tool" ? `${last.name} ${toolHead(last.input) || last.partialJson}` : names.join(" · ")}
        </span>
      </summary>
      <div className="border-t border-line">
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-xs text-muted hover:bg-subtle hover:text-fg"
            data-testid="feed-steps-more">
            <ChevronIcon className="h-3 w-3 rotate-90" />
            ещё {hidden} {plural(hidden, "шаг", "шага", "шагов")} раньше
          </button>
        )}
        <ul className="divide-y divide-line">
          {shown.map((step) => (
            <li key={step.id}>{step.kind === "tool" ? <ToolStep item={step} /> : <ThinkingStep item={step} />}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

const plural = (n: number, one: string, few: string, many: string): string => {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
};

// One row of a step: a status mark, a label, a one-line summary; a click unfolds the body.
function StepRow({
  mark,
  label,
  summary,
  tone = "neutral",
  testId,
  data,
  children,
}: {
  mark: ReactNode;
  label: ReactNode;
  summary: ReactNode;
  tone?: "neutral" | "danger" | "soft";
  testId: string;
  data?: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <details className={cx("group/step", tone === "danger" && "bg-danger-soft")} data-testid={testId} {...data}>
      <summary className="flex min-w-0 list-none items-center gap-2 px-3 py-1.5 text-xs select-none hover:bg-subtle [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="h-3 w-3 shrink-0 text-muted transition-transform group-open/step:rotate-90" />
        <span className="flex w-4 shrink-0 justify-center">{mark}</span>
        <span className={cx("shrink-0 font-medium", tone === "danger" ? "text-danger-text" : tone === "soft" ? "text-muted italic" : "text-fg")}>{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted">{summary}</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-dashed border-line px-3 pt-2 pb-3 pl-[2.75rem]">{children}</div>
    </details>
  );
}

function ThinkingStep({ item }: { item: ThinkingItem }) {
  const preview = item.text.trim().split(/\r?\n/)[0] ?? "";
  return (
    <StepRow
      mark={item.streaming ? <Spinner className="h-3 w-3 text-muted" /> : <ThoughtIcon className="h-3.5 w-3.5 text-muted" />}
      label={item.streaming ? "Размышляет…" : "Размышление"}
      summary={<span className="font-sans italic">{preview}</span>}
      tone="soft"
      testId="feed-thinking">
      <div className="text-xs leading-relaxed whitespace-pre-wrap text-muted">{item.text}</div>
    </StepRow>
  );
}

function ToolStep({ item }: { item: ToolItem }) {
  const running = item.streaming || item.result === null;
  const mark = item.isError ? (
    <span className="h-2 w-2 rounded-full bg-danger" aria-label="ошибка" />
  ) : running ? (
    <Spinner className="h-3 w-3 text-accent" />
  ) : (
    <ToolIcon name={item.name} className="h-3.5 w-3.5 text-muted" />
  );
  return (
    <StepRow
      mark={mark}
      label={item.name}
      summary={toolHead(item.input) || item.partialJson}
      tone={item.isError ? "danger" : "neutral"}
      testId="feed-tool"
      data={{ "data-tool": item.name }}>
      <ToolInput item={item} />
      {item.result !== null ? (
        <Section title={item.isError ? "Ошибка" : "Результат"}>
          <Code tone={item.isError ? "danger" : "neutral"}>{cleanResult(item.result) || "(пусто)"}</Code>
        </Section>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3 w-3" /> выполняется…
        </div>
      )}
    </StepRow>
  );
}

const cleanResult = (result: string): string => result.replace(/<\/?tool_use_error>/g, "").trim();

const str = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

// The input in the shape a human reads it: a shell command as a command, an edit as a diff,
// anything else as JSON.
function ToolInput({ item }: { item: ToolItem }) {
  const input = item.input;
  if (typeof input !== "object" || input === null) {
    const raw = formatInput(input) || item.partialJson;
    return raw ? (
      <Section title="Ввод">
        <Code>{raw}</Code>
      </Section>
    ) : null;
  }
  const record = input as Record<string, unknown>;
  const command = str(record, "command");
  const description = str(record, "description");
  if (command !== undefined) {
    return (
      <Section title={description ?? "Команда"}>
        <Code>
          <span className="text-muted select-none">$ </span>
          {command}
        </Code>
      </Section>
    );
  }
  const path = str(record, "file_path");
  const oldString = str(record, "old_string");
  const newString = str(record, "new_string");
  if (path !== undefined && oldString !== undefined && newString !== undefined) {
    return (
      <Section title={path}>
        <Diff before={oldString} after={newString} />
      </Section>
    );
  }
  const content = str(record, "content");
  if (path !== undefined && content !== undefined) {
    return (
      <Section title={path}>
        <Code>{content}</Code>
      </Section>
    );
  }
  return (
    <Section title="Ввод">
      <Code>{formatInput(input)}</Code>
    </Section>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="truncate text-[11px] font-medium text-muted">{title}</div>
      {children}
    </div>
  );
}

function Code({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "danger" }) {
  return (
    <pre
      className={cx(
        "max-h-80 overflow-auto rounded-md border px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words",
        tone === "danger" ? "border-danger/30 bg-danger-soft text-danger-text" : "border-line bg-surface text-fg",
      )}>
      {children}
    </pre>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = (text: string) => (text === "" ? [] : text.split(/\r?\n/));
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-line bg-surface py-1.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words">
      {lines(before).map((line, i) => (
        <div key={`-${i}`} className="bg-danger-soft px-2.5 text-danger-text">
          <span className="select-none">- </span>
          {line}
        </div>
      ))}
      {lines(after).map((line, i) => (
        <div key={`+${i}`} className="bg-ok-soft px-2.5 text-ok">
          <span className="select-none">+ </span>
          {line}
        </div>
      ))}
    </pre>
  );
}

// The QA verdict is JSON for the Orchestrator; a person reads it as a status, a summary and the blockers.
function VerdictCard({ verdict }: { verdict: Verdict }) {
  const tone = verdict.approved ? "border-ok bg-ok-soft" : "border-danger bg-danger-soft";
  return (
    <div className={`rounded-r-lg border-l-[3px] px-3 py-2.5 ${tone}`} data-testid="feed-verdict" data-approved={verdict.approved}>
      <div className={`mb-1 font-semibold ${verdict.approved ? "text-ok" : "text-danger-text"}`}>
        {verdict.approved ? "✓ Вердикт QA: одобрено" : "✗ Вердикт QA: не одобрено"}
      </div>
      <div className="break-words">
        <MarkdownText text={verdict.summary} />
      </div>
      {verdict.blockers.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-semibold tracking-wider text-muted uppercase">Blockers</div>
          <ol className="mt-1 list-decimal pl-5">
            {verdict.blockers.map((blocker, i) => (
              <li key={i} className="my-1 break-words">
                <code className="rounded bg-subtle px-1 py-px font-mono text-[0.85em]">{blocker.where}</code>: {blocker.what}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// The first message of a Session is the prompt the Orchestrator launched the Agent with: long and the
// same every time, so it stays folded until asked for.
function LaunchPrompt({ text }: { text: string }) {
  return (
    <details className="group/prompt rounded-lg border border-line bg-surface-2/60 text-xs" data-testid="feed-prompt">
      <summary className="flex list-none items-center gap-2 px-3 py-1.5 text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="h-3 w-3 transition-transform group-open/prompt:rotate-90" />
        Промпт запуска
      </summary>
      <div className="border-t border-dashed border-line px-3 py-2 text-sm break-words">
        <MarkdownText text={text} />
      </div>
    </details>
  );
}

function SubagentBlock({ item, all }: { item: ToolItem; all: FeedItem[] }) {
  const children = childrenOf(all, item.id);
  const label = item.subagent?.type ?? item.name;
  const description = item.subagent?.description ?? toolHead(item.input);
  const running = item.result === null;
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-soft/40" data-testid="feed-subagent">
      <div className="flex items-center gap-2 border-b border-accent/20 px-3 py-1.5 text-xs text-muted">
        {item.isError ? (
          <span className="h-2 w-2 rounded-full bg-danger" aria-label="ошибка" />
        ) : running ? (
          <Spinner className="h-3 w-3 text-accent" />
        ) : (
          <AgentIcon className="h-3.5 w-3.5 text-accent" />
        )}
        <span>
          сабагент <b className="text-fg">{label}</b>: {description}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        <FeedList items={children} all={all} />
        {item.result !== null && (
          <details className="group/result text-xs text-muted">
            <summary className="flex w-fit list-none items-center gap-1.5 select-none hover:text-fg [&::-webkit-details-marker]:hidden">
              <ChevronIcon className="h-3 w-3 transition-transform group-open/result:rotate-90" />
              результат
            </summary>
            <div className="mt-1.5">
              <Code>{item.result}</Code>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

// Icons

type IconProps = { className?: string | undefined };

function Svg({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function ChevronIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 4l4 4-4 4" />
    </Svg>
  );
}

function StepsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M2.5 4h7M2.5 8h11M2.5 12h5" />
    </Svg>
  );
}

function ThoughtIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M8 2.5a4 4 0 0 0-2.4 7.2c.4.3.6.7.6 1.1v.7h3.6v-.7c0-.4.2-.8.6-1.1A4 4 0 0 0 8 2.5z" />
      <path d="M6.5 14h3" />
    </Svg>
  );
}

function AgentIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2.5V5M6 9h.01M10 9h.01" />
    </Svg>
  );
}

function ToolIcon({ name, className }: IconProps & { name: string }) {
  switch (name) {
    case "Bash":
    case "Monitor":
    case "BashOutput":
      return (
        <Svg className={className}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
          <path d="M4.5 6l2 2-2 2M8.5 10.5h3" />
        </Svg>
      );
    case "Read":
      return (
        <Svg className={className}>
          <path d="M4 1.5h5l3 3v10H4z" />
          <path d="M9 1.5v3h3M6 8h4M6 10.5h4" />
        </Svg>
      );
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return (
        <Svg className={className}>
          <path d="M10.5 2.5l3 3L6 13H3v-3z" />
        </Svg>
      );
    case "Grep":
    case "Glob":
    case "ToolSearch":
      return (
        <Svg className={className}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </Svg>
      );
    case "WebFetch":
    case "WebSearch":
      return (
        <Svg className={className}>
          <circle cx="8" cy="8" r="6" />
          <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
        </Svg>
      );
    default:
      return (
        <Svg className={className}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="3" />
          <circle cx="8" cy="8" r="1.5" />
        </Svg>
      );
  }
}
