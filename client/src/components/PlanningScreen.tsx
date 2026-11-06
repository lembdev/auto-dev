import { useState, type ReactNode } from "react";
import type { PlannerMode, PlannerResponse } from "../../../src/server/api-types.js";
import { useSessionFeed } from "../agent-feed.js";
import { useDialogueOutbox } from "../dialogue.js";
import type { FeedState } from "../feed.js";
import { AGENT_LABELS } from "../format.js";
import { fetchPlannerHistory, useFinishPlanner, useInterruptPlanner, usePlanner, useRemovePlannerLine, useStartPlanner } from "../queries.js";
import { AgentFeed } from "./AgentFeed.js";
import { DialogueBoxView } from "./DialogueBox.js";

// The planning mode: the choice between the last Session and a new one, then the Dialogue with the Planner
// (the feed and the Dialogue box of the Agent panel) and "Завершить планирование".
export function PlanningScreen() {
  const planner = usePlanner();
  const start = useStartPlanner();
  const finish = useFinishPlanner();
  const interrupt = useInterruptPlanner();
  const remove = useRemovePlannerLine();
  const outbox = useDialogueOutbox("planner");
  const open = planner.data?.open === true;
  const feed = useSessionFeed("planner", open ? (planner.data?.agent?.id ?? null) : null, fetchPlannerHistory);
  const queue = (planner.data?.queue ?? []).map((line) => ({ id: line.id, text: line.text, source: "ui" as const }));
  return (
    <PlanningScreenView
      planner={planner.data ?? null}
      loadError={planner.error?.message ?? null}
      onStart={(mode, message) => start.mutate({ mode, ...(message !== "" ? { message } : {}) })}
      startPending={start.isPending}
      startError={start.error?.message ?? null}
      onFinish={() => finish.mutate()}
      finishPending={finish.isPending}
      onInterrupt={() => interrupt.mutate()}
      interruptPending={interrupt.isPending}
      actionError={finish.error?.message ?? interrupt.error?.message ?? null}
      feed={feed.feed}
      feedStatus={feed.status}
      feedError={feed.error}
      dialogueSlot={
        <DialogueBoxView
          queue={queue}
          pending={outbox.pending}
          lastAck={outbox.lastAck}
          onSend={(text) => outbox.send({ kind: "planner" }, text)}
          onRemove={(id) => remove.mutate(id)}
          removing={remove.isPending ? (remove.variables ?? null) : null}
          error={remove.error?.message ?? null}
        />
      }
    />
  );
}

export type PlanningScreenViewProps = {
  planner: PlannerResponse | null;
  loadError: string | null;
  onStart: (mode: PlannerMode, message: string) => void;
  startPending: boolean;
  startError: string | null;
  onFinish: () => void;
  finishPending: boolean;
  onInterrupt: () => void;
  interruptPending: boolean;
  actionError: string | null;
  feed: FeedState;
  feedStatus: "loading" | "live" | "error";
  feedError: string | null;
  dialogueSlot: ReactNode;
};

export function PlanningScreenView(props: PlanningScreenViewProps) {
  const { planner } = props;
  if (!planner) {
    return (
      <main className="mx-auto mt-16 max-w-2xl px-4 text-center text-neutral-500">
        {props.loadError ? <span role="alert">Режим планирования недоступен: {props.loadError}</span> : "Загрузка…"}
      </main>
    );
  }
  return planner.open ? <PlanningDialogue {...props} planner={planner} /> : <PlanningStart {...props} planner={planner} />;
}

type WithPlanner = PlanningScreenViewProps & { planner: PlannerResponse };

function PlanningStart(props: WithPlanner) {
  const [message, setMessage] = useState("");
  const { planner } = props;
  const start = (mode: PlannerMode) => props.onStart(mode, message.trim());
  return (
    <main className="mx-auto mt-10 flex max-w-2xl flex-col gap-3 px-4" aria-label="Режим планирования">
      <h1 className="text-xl font-semibold">Режим планирования</h1>
      <p className="text-sm text-neutral-500">
        Планировщик читает открытые milestones, issues и код Продукта на ветке main и превращает замысел в milestones, Epic, Spec и Задачи. Он ничего не коммитит; Задачи с
        ready-for-agent Оркестратор берёт сам.
      </p>
      <textarea
        className="rounded-md border border-neutral-300 bg-white p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        rows={4}
        aria-label="Первое сообщение Планировщику"
        placeholder="Замысел или указание (необязательно)"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-neutral-700"
          disabled={!planner.canResume || props.startPending}
          title={planner.canResume ? undefined : "Прошлой Сессии планирования нет"}
          onClick={() => start("resume")}
        >
          Продолжить прошлую
        </button>
        <button type="button" className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50" disabled={props.startPending} onClick={() => start("new")}>
          Начать новую
        </button>
        {!planner.canResume && <span className="text-xs text-neutral-500">Прошлой Сессии нет</span>}
      </div>
      {props.startError && (
        <div className="text-sm text-red-600" role="alert">
          Не запущено: {props.startError}
        </div>
      )}
    </main>
  );
}

function PlanningDialogue(props: WithPlanner) {
  const { planner } = props;
  const running = planner.status === "running";
  return (
    <main className="mx-auto flex h-[calc(100vh-4rem)] max-w-4xl flex-col px-4" aria-label="Режим планирования">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-300 py-2.5 dark:border-neutral-700">
        <span className="font-semibold">Планировщик</span>
        {planner.agent && (
          <span className="rounded-full border border-neutral-300 px-2 py-px text-[11px] text-neutral-500 dark:border-neutral-700">
            {planner.status === "stopped" ? "процесс погашен, ответ его продолжит" : AGENT_LABELS[planner.agent.state]}
          </span>
        )}
        <span className="flex-1" />
        {running && (
          <button type="button" className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs disabled:opacity-50 dark:border-neutral-700" disabled={props.interruptPending} onClick={props.onInterrupt}>
            Остановить ход
          </button>
        )}
        <button type="button" className="rounded-md border border-red-300 px-2 py-0.5 text-xs text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400" disabled={props.finishPending} onClick={props.onFinish}>
          Завершить планирование
        </button>
      </div>
      <AgentFeed feed={props.feed} status={props.feedStatus} error={props.feedError} />
      <div className="flex flex-col gap-2 border-t border-neutral-300 py-2.5 text-sm dark:border-neutral-700">
        {props.dialogueSlot}
        {props.actionError && (
          <span className="text-xs text-red-600" role="alert">
            {props.actionError}
          </span>
        )}
      </div>
    </main>
  );
}
