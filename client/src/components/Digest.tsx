import type { DigestResponse } from "../../../src/server/api-types.js";
import { dateTime, firstLine } from "../format.js";

export type DigestProps = {
  since: string | null;
  digest: DigestResponse | undefined;
  onOpenRequest: (issueNumber: number) => void;
};

const join = (items: React.ReactNode[]): React.ReactNode =>
  items.length === 0 ? "нет" : items.flatMap((item, index) => (index === 0 ? [item] : [", ", item]));

// What happened since the previous visit: Requests open the panel, the rest is read-only.
export function Digest({ since, digest, onOpenRequest }: DigestProps) {
  return (
    <section className="rounded-lg border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900" aria-label="С прошлого визита">
      <b>
        С прошлого визита <span className="font-normal text-neutral-500">({since ? dateTime(since) : "первый визит"})</span>
      </b>
      {since === null ? (
        <div className="mt-1 text-sm text-neutral-500">Это первый визит с этого браузера; дальше здесь будут Запросы, завершённые Задачи и Тупики.</div>
      ) : (
        <ul className="mt-1.5 list-disc pl-5 text-sm">
          <li data-testid="digest-requests">
            Запросы к человеку:{" "}
            {join(
              (digest?.requests ?? []).map((request) => (
                <button
                  type="button"
                  key={request.id}
                  className={`text-blue-600 underline ${request.open ? "" : "line-through opacity-70"}`}
                  title={request.question ? firstLine(request.question) : undefined}
                  onClick={() => onOpenRequest(request.issueNumber)}
                >
                  #{request.issueNumber} {request.title ?? ""}
                </button>
              )),
            )}
          </li>
          <li data-testid="digest-done">
            Завершённые Задачи:{" "}
            {join(
              (digest?.done ?? []).map((task) => (
                <span key={task.issueNumber}>
                  #{task.issueNumber} {task.title ?? ""}
                  {task.pullNumber !== null && (
                    <span className="text-neutral-500">
                      {" "}
                      (PR{" "}
                      {task.pullUrl ? (
                        <a href={task.pullUrl} target="_blank" rel="noreferrer" className="text-blue-600">
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
          </li>
          <li data-testid="digest-stuck">
            Тупики:{" "}
            {join(
              (digest?.stuck ?? []).map((task) => (
                <span key={task.issueNumber} title={task.reason ?? undefined}>
                  #{task.issueNumber} {task.title ?? ""}
                </span>
              )),
            )}
          </li>
        </ul>
      )}
    </section>
  );
}
