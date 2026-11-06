import type { DigestResponse } from "../../../src/server/api-types.js";
import { dateTime, firstLine } from "../format.js";
import { Card, LINK } from "./ui.js";

export type DigestProps = {
  since: string | null;
  digest: DigestResponse | undefined;
  onOpenRequest: (issueNumber: number) => void;
};

const join = (items: React.ReactNode[]): React.ReactNode =>
  items.length === 0 ? <span className="text-muted">нет</span> : items.flatMap((item, index) => (index === 0 ? [item] : [", ", item]));

const ROW = "grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 py-1.5 max-sm:grid-cols-1";
const LABEL = "text-muted";

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
        <ul className="mt-2 divide-y divide-line text-sm">
          <li data-testid="digest-requests" className={ROW}>
            <span className={LABEL}>Запросы к человеку:</span>{" "}
            <span>
            {join(
              (digest?.requests ?? []).map((request) => (
                <button
                  type="button"
                  key={request.id}
                  className={`${LINK} text-left ${request.open ? "font-medium" : "line-through opacity-70"}`}
                  title={request.question ? firstLine(request.question) : undefined}
                  onClick={() => onOpenRequest(request.issueNumber)}
                >
                  #{request.issueNumber} {request.title ?? ""}
                </button>
              )),
            )}
            </span>
          </li>
          <li data-testid="digest-done" className={ROW}>
            <span className={LABEL}>Завершённые Задачи:</span>{" "}
            <span>
            {join(
              (digest?.done ?? []).map((task) => (
                <span key={task.issueNumber}>
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
                </span>
              )),
            )}
            </span>
          </li>
          <li data-testid="digest-stuck" className={ROW}>
            <span className={LABEL}>Тупики:</span>{" "}
            <span>
            {join(
              (digest?.stuck ?? []).map((task) => (
                <span key={task.issueNumber} title={task.reason ?? undefined}>
                  #{task.issueNumber} {task.title ?? ""}
                </span>
              )),
            )}
            </span>
          </li>
        </ul>
      )}
    </Card>
  );
}
