import { useEffect, useRef } from "react";
import { splitVerdict, type Verdict } from "../../../src/orchestrator/verdict.js";
import { MarkdownText } from "./MarkdownText.js";
import { childrenOf, formatInput, toolHead, topLevelOf, type FeedItem, type FeedState, type ToolItem } from "../feed.js";

export type AgentFeedProps = {
  feed: FeedState;
  status: "loading" | "live" | "error";
  error: string | null;
};

// Rows of the panel: streamed text, collapsed thinking, tool calls as one line that unfolds into the
// input and the result, grey system rows, subagents as nested blocks under the call that started them.
export function AgentFeed({ feed, status, error }: AgentFeedProps) {
  const container = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const count = feed.items.length;

  useEffect(() => {
    const element = container.current;
    if (!element || !stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [count, feed]);

  const onScroll = () => {
    const element = container.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };

  return (
    <div ref={container} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto px-3.5 py-3" data-testid="agent-feed" data-status={status}>
      {status === "loading" && <div className="text-xs text-neutral-500">Загрузка истории Сессии…</div>}
      {status === "error" && (
        <div className="text-xs text-red-600" role="alert">
          История не загружена: {error}
        </div>
      )}
      {status === "live" && count === 0 && <div className="text-xs text-neutral-500 italic">Сессия пока пуста.</div>}
      {topLevelOf(feed.items).map((item, index) =>
        index === 0 && item.kind === "user" ? <LaunchPrompt key={item.id} text={item.text} /> : <FeedRow key={item.id} item={item} items={feed.items} />,
      )}
    </div>
  );
}

function FeedRow({ item, items }: { item: FeedItem; items: FeedItem[] }) {
  switch (item.kind) {
    case "text": {
      const split = item.streaming ? undefined : splitVerdict(item.text);
      if (split) {
        return (
          <>
            {split.rest !== "" && (
              <div className="break-words" data-testid="feed-text" data-streaming={false}>
                <MarkdownText text={split.rest} />
              </div>
            )}
            <VerdictCard verdict={split.verdict} />
          </>
        );
      }
      return (
        <div className="break-words" data-testid="feed-text" data-streaming={item.streaming}>
          <MarkdownText text={item.text} />
          {item.streaming && <span className="animate-pulse text-neutral-400">▍</span>}
        </div>
      );
    }
    case "thinking":
      return (
        <details className="text-xs text-neutral-500" data-testid="feed-thinking">
          <summary className="cursor-pointer">thinking{item.streaming ? "…" : ""}</summary>
          <div className="mt-1 whitespace-pre-wrap">{item.text}</div>
        </details>
      );
    case "user":
      return (
        <div className="rounded-md bg-blue-50 px-2.5 py-1.5 break-words dark:bg-blue-950" data-testid="feed-user">
          <MarkdownText text={item.text} />
        </div>
      );
    case "system":
      return (
        <div className={`text-xs ${item.level === "warn" ? "text-amber-700 dark:text-amber-400" : "text-neutral-500"}`} data-testid="feed-system" data-level={item.level}>
          {item.text}
        </div>
      );
    case "tool":
      return <ToolRow item={item} items={items} />;
  }
}

// The QA verdict is JSON for the Orchestrator; a person reads it as a status, a summary and the blockers.
function VerdictCard({ verdict }: { verdict: Verdict }) {
  const tone = verdict.approved
    ? "border-green-600 bg-green-50 dark:border-green-500 dark:bg-green-950/40"
    : "border-red-600 bg-red-50 dark:border-red-500 dark:bg-red-950/40";
  return (
    <div className={`rounded-r-md border-l-[3px] px-2.5 py-2 ${tone}`} data-testid="feed-verdict" data-approved={verdict.approved}>
      <div className={`mb-1 font-semibold ${verdict.approved ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
        {verdict.approved ? "✓ Вердикт QA: одобрено" : "✗ Вердикт QA: не одобрено"}
      </div>
      <div className="break-words">
        <MarkdownText text={verdict.summary} />
      </div>
      {verdict.blockers.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Blockers</div>
          <ol className="mt-1 list-decimal pl-5">
            {verdict.blockers.map((blocker, i) => (
              <li key={i} className="my-1 break-words">
                <code className="rounded bg-neutral-200/70 px-1 py-px font-mono text-[0.85em] dark:bg-neutral-800">{blocker.where}</code>: {blocker.what}
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
    <details className="rounded-md bg-blue-50 px-2.5 py-1.5 text-xs dark:bg-blue-950" data-testid="feed-prompt">
      <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">Промпт запуска</summary>
      <div className="mt-1.5 border-t border-dashed border-blue-200 pt-1.5 text-sm break-words dark:border-blue-900">
        <MarkdownText text={text} />
      </div>
    </details>
  );
}

function ToolRow({ item, items }: { item: ToolItem; items: FeedItem[] }) {
  const children = childrenOf(items, item.id);
  if (item.subagent || children.length > 0) {
    const label = item.subagent?.type ?? item.name;
    const description = item.subagent?.description ?? toolHead(item.input);
    return (
      <div className="rounded-r-md border-l-[3px] border-blue-500 bg-blue-50/60 px-2.5 py-1.5 dark:bg-blue-950/40" data-testid="feed-subagent">
        <div className="mb-1 text-xs text-neutral-500">
          сабагент <b className="text-neutral-900 dark:text-neutral-100">{label}</b>: {description}
        </div>
        <div className="flex flex-col gap-1.5">
          {children.map((child) => (
            <FeedRow key={child.id} item={child} items={items} />
          ))}
        </div>
        {item.result !== null && (
          <details className="mt-1 text-xs text-neutral-500">
            <summary className="cursor-pointer">результат</summary>
            <pre className="mt-1 whitespace-pre-wrap">{item.result}</pre>
          </details>
        )}
      </div>
    );
  }
  const state = item.streaming ? "…" : item.result === null ? " (ожидание)" : item.isError ? " (ошибка)" : "";
  return (
    <details className={`rounded-md px-2 py-1 font-mono text-xs ${item.isError ? "bg-red-50 dark:bg-red-950/40" : "bg-neutral-200/70 dark:bg-neutral-800"}`} data-testid="feed-tool" data-tool={item.name}>
      <summary className="cursor-pointer">
        <b>{item.name}</b> {toolHead(item.input)}
        {state}
      </summary>
      <pre className="mt-1.5 border-t border-dashed border-neutral-400 pt-1.5 whitespace-pre-wrap dark:border-neutral-600">
        {`input: ${formatInput(item.input) || item.partialJson}`}
        {item.result !== null ? `\n\nresult: ${item.result}` : ""}
      </pre>
    </details>
  );
}
