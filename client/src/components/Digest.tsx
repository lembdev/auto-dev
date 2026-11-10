import type { ReactNode } from "react";
import type { DigestResponse } from "../../../src/server/api-types.js";
import { dateTime, firstLine } from "../format.js";
import { Accordion, Card, LINK } from "./ui.js";

export type DigestProps = {
  since: string | null;
  digest: DigestResponse | undefined;
  onOpenRequest: (issueNumber: number) => void;
};

// One group of the digest: a Task per line, open when it has something to read. The digest arrives
// after the first render, so the group starts over once it stops being empty.
function Group({ title, testId, items }: { title: string; testId: string; items: { key: number; node: ReactNode }[] }) {
  return (
    <Accordion key={items.length > 0 ? "filled" : "empty"} title={<span className="text-muted">{title}</span>} count={items.length} defaultOpen={items.length > 0} data-testid={testId} className="py-1.5" summaryClassName="py-0.5">
      {items.length === 0 ? (
        <div className="mt-1 pl-5 text-muted">нет</div>
      ) : (
        <ul className="mt-1 flex flex-col gap-1 pl-5">
          {items.map((item) => (
            <li key={item.key}>{item.node}</li>
          ))}
        </ul>
      )}
    </Accordion>
  );
}

// What happened since the previous visit: Requests open the panel, the rest is read-only.
export function Digest({ since, digest, onOpenRequest }: DigestProps) {
  return (
    <Card aria-label="С прошлого визита">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="font-semibold">С прошлого визита</h2>
        <span className="text-xs text-muted">{since ? dateTime(since) : "первый визит"}</span>
      </div>
      {since === null ? (
        <div className="mt-1 text-sm text-muted">Это первый визит с этого браузера; дальше здесь будут Запросы, завершённые Задачи и Тупики.</div>
      ) : (
        <div className="mt-2 divide-y divide-line text-sm">
          <Group
            title="Запросы к человеку"
            testId="digest-requests"
            items={(digest?.requests ?? []).map((request) => ({
              key: request.id,
              node: (
                <button
                  type="button"
                  className={`${LINK} text-left ${request.open ? "font-medium" : "line-through opacity-70"}`}
                  title={request.question ? firstLine(request.question) : undefined}
                  onClick={() => onOpenRequest(request.issueNumber)}
                >
                  #{request.issueNumber} {request.title ?? ""}
                </button>
              ),
            }))}
          />
          <Group
            title="Завершённые Задачи"
            testId="digest-done"
            items={(digest?.done ?? []).map((task) => ({
              key: task.issueNumber,
              node: (
                <>
                  #{task.issueNumber} {task.title ?? ""}
                  {task.pullNumber !== null && (
                    <span className="text-muted">
                      {" "}
                      (PR{" "}
                      {task.pullUrl ? (
                        <a href={task.pullUrl} target="_blank" rel="noreferrer" className={LINK}>
                          #{task.pullNumber}
                        </a>
                      ) : (
                        `#${task.pullNumber}`
                      )}{" "}
                      влит)
                    </span>
                  )}
                </>
              ),
            }))}
          />
          <Group
            title="Тупики"
            testId="digest-stuck"
            items={(digest?.stuck ?? []).map((task) => ({
              key: task.issueNumber,
              node: (
                <span title={task.reason ?? undefined}>
                  #{task.issueNumber} {task.title ?? ""}
                </span>
              ),
            }))}
          />
        </div>
      )}
    </Card>
  );
}
