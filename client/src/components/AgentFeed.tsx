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
    <div ref={container} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-4 py-3" data-testid="agent-feed" data-status={status}>
      {status === "loading" && <div className="text-xs text-muted">Загрузка истории Сессии…</div>}
      {status === "error" && (
        <div className="text-xs text-danger-text" role="alert">
          История не загружена: {error}
        </div>
      )}
      {status === "live" && count === 0 && <div className="py-8 text-center text-sm text-muted">Сессия пока пуста.</div>}
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
          {item.streaming && <span className="animate-pulse text-muted">▍</span>}
        </div>
      );
    }
    case "thinking":
      return (
        <details className="group text-xs text-muted" data-testid="feed-thinking">
          <summary className="w-fit rounded px-1 -mx-1 italic hover:bg-subtle">thinking{item.streaming ? "…" : ""}</summary>
          <div className="mt-1 border-l-2 border-line pl-2.5 whitespace-pre-wrap">{item.text}</div>
        </details>
      );
    case "user":
      return (
        <div className="ml-8 self-end rounded-xl rounded-br-sm bg-accent-soft px-3 py-2 break-words ring-1 ring-accent/20" data-testid="feed-user">
          <MarkdownText text={item.text} />
        </div>
      );
    case "system":
      return (
        <div className={`flex items-center gap-2 text-xs before:h-px before:w-3 before:bg-current before:opacity-40 ${item.level === "warn" ? "text-warn" : "text-muted"}`} data-testid="feed-system" data-level={item.level}>
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
    ? "border-ok bg-ok-soft"
    : "border-danger bg-danger-soft";
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
    <details className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs" data-testid="feed-prompt">
      <summary className="text-muted hover:text-fg">Промпт запуска</summary>
      <div className="mt-1.5 border-t border-dashed border-line pt-1.5 text-sm break-words">
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
      <div className="rounded-r-lg border-l-[3px] border-accent bg-accent-soft/50 px-3 py-2" data-testid="feed-subagent">
        <div className="mb-1.5 text-xs text-muted">
          сабагент <b className="text-fg">{label}</b>: {description}
        </div>
        <div className="flex flex-col gap-1.5">
          {children.map((child) => (
            <FeedRow key={child.id} item={child} items={items} />
          ))}
        </div>
        {item.result !== null && (
          <details className="mt-1.5 text-xs text-muted">
            <summary className="w-fit hover:text-fg">результат</summary>
            <pre className="mt-1 font-mono whitespace-pre-wrap">{item.result}</pre>
          </details>
        )}
      </div>
    );
  }
  const state = item.streaming ? "…" : item.result === null ? " (ожидание)" : item.isError ? " (ошибка)" : "";
  return (
    <details className={`rounded-md border px-2.5 py-1 font-mono text-xs ${item.isError ? "border-danger/40 bg-danger-soft" : "border-line bg-surface-2"}`} data-testid="feed-tool" data-tool={item.name}>
      <summary className="truncate">
        <b className={item.isError ? "text-danger-text" : "text-fg"}>{item.name}</b> <span className="text-muted">{toolHead(item.input)}</span>
        {state}
      </summary>
      <pre className="mt-1.5 max-h-80 overflow-auto border-t border-dashed border-line pt-1.5 whitespace-pre-wrap">
        {`input: ${formatInput(item.input) || item.partialJson}`}
        {item.result !== null ? `\n\nresult: ${item.result}` : ""}
      </pre>
    </details>
  );
}
