import type { TaskView } from "../../../src/server/api-types.js";
import { AGENT_LABELS, stageLabel } from "../format.js";

export type AgentPanelProps = {
  task: TaskView;
  maxQaRounds: number;
  // True when opened by the "Ответить" button: the Request block gets the focus once it exists.
  answering: boolean;
  onClose: () => void;
};

// The drawer of one Agent. The event feed, the Request block, the Dialogue and the buttons are built
// by the next tickets; this is the frame they fill.
export function AgentPanel({ task, maxQaRounds, answering, onClose }: AgentPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col" role="dialog" aria-label={`Агент Задачи #${task.issueNumber}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-300 px-3.5 py-2.5 dark:border-neutral-700">
        <button type="button" className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700" onClick={onClose}>
          закрыть
        </button>
        <span className="font-semibold">
          #{task.issueNumber} {task.title}
        </span>
        <span className="rounded-full border border-neutral-300 px-2 py-px text-[11px] text-neutral-500 dark:border-neutral-700">{stageLabel(task, maxQaRounds)}</span>
        {task.agent && <span className="rounded-full border border-neutral-300 px-2 py-px text-[11px] text-neutral-500 dark:border-neutral-700">{AGENT_LABELS[task.agent.state]}</span>}
        {task.pullUrl && task.pullNumber !== null && (
          <a href={task.pullUrl} target="_blank" rel="noreferrer" className="text-blue-600">
            PR #{task.pullNumber}
          </a>
        )}
      </div>
      <div className="flex-1 overflow-auto px-3.5 py-3 text-sm text-neutral-500">
        {answering && task.request && (
          <div className="mb-3 rounded-lg border border-wait-border bg-wait p-3 text-neutral-900 dark:border-wait-border-dark dark:bg-wait-dark dark:text-neutral-100">
            <div className="text-xs text-neutral-500">
              Запрос к человеку
              {task.request.commentUrl && (
                <>
                  {" · "}
                  <a href={task.request.commentUrl} target="_blank" rel="noreferrer" className="text-blue-600">
                    комментарий в issue
                  </a>
                </>
              )}
            </div>
            <div className="mt-1 whitespace-pre-wrap font-semibold">{task.request.question ?? "текст Запроса в комментарии issue"}</div>
            {task.request.options.length > 0 && <div className="mt-1 text-xs text-neutral-500">Варианты: {task.request.options.join(" · ")}</div>}
            <div className="mt-2 text-xs text-neutral-500">Ответ из UI появится в следующем тикете; пока ответьте комментарием в issue.</div>
          </div>
        )}
        <p>Лента событий Сессии, Диалог и кнопки появятся в следующих тикетах.</p>
      </div>
    </div>
  );
}
