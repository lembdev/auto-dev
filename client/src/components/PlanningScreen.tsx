import { useState, type ReactNode } from "react";
import type { PlannerMode, PlannerResponse } from "../../../src/server/api-types.js";
import { useSessionFeed } from "../agent-feed.js";
import { useDialogueOutbox } from "../dialogue.js";
import type { FeedState } from "../feed.js";
import { AGENT_LABELS } from "../format.js";
import { fetchPlannerHistory, useFinishPlanner, useInterruptPlanner, usePlanner, useRemovePlannerLine, useStartPlanner } from "../queries.js";
import { AgentFeed } from "./AgentFeed.js";
import { DialogueBoxView } from "./DialogueBox.js";
import { Badge, Banner, Button, Card, cx, INPUT, Spinner } from "./ui.js";

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
      <main className="mx-auto mt-16 flex max-w-2xl justify-center px-4 text-muted">
        {props.loadError ? (
          <Banner tone="danger" role="alert">
            Режим планирования недоступен: {props.loadError}
          </Banner>
        ) : (
          <span className="inline-flex items-center gap-2">
            <Spinner /> Загрузка…
          </span>
        )}
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
    <main className="mx-auto max-w-2xl px-4 pt-10 pb-20" aria-label="Режим планирования">
      <Card className="flex flex-col gap-4 p-6">
        <div>
          <h1 className="text-xl font-semibold">Режим планирования</h1>
          <p className="mt-1.5 text-sm text-muted">
            Планировщик читает открытые milestones, issues и код Продукта на ветке main и превращает замысел в milestones, Epic, Spec и Задачи. Он ничего не коммитит; Задачи с
            ready-for-agent Оркестратор берёт сам.
          </p>
        </div>
        <textarea
          className={cx(INPUT, "resize-y")}
          rows={4}
          aria-label="Первое сообщение Планировщику"
          placeholder="Замысел или указание (необязательно)"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={props.startPending} onClick={() => start("new")}>
            {props.startPending && <Spinner />}
            Начать новую
          </Button>
          <Button disabled={!planner.canResume || props.startPending} title={planner.canResume ? undefined : "Прошлой Сессии планирования нет"} onClick={() => start("resume")}>
            Продолжить прошлую
          </Button>
          {!planner.canResume && <span className="text-xs text-muted">Прошлой Сессии нет</span>}
        </div>
        {props.startError && (
          <Banner tone="danger" role="alert">
            Не запущено: {props.startError}
          </Banner>
        )}
      </Card>
    </main>
  );
}

function PlanningDialogue(props: WithPlanner) {
  const { planner } = props;
  const running = planner.status === "running";
  const state = planner.agent ? (planner.status === "stopped" ? "процесс погашен, ответ его продолжит" : AGENT_LABELS[planner.agent.state]) : null;
  return (
    <main className="mx-auto flex h-full max-w-4xl flex-col px-4" aria-label="Режим планирования">
      <div className="flex flex-wrap items-center gap-2 border-b border-line py-3">
        <span className="font-semibold">Планировщик</span>
        {state && (
          <Badge tone={running ? "ok" : planner.agent?.state === "waiting" ? "warn" : "neutral"} dot>
            {state}
          </Badge>
        )}
        <span className="flex-1" />
        {running && (
          <Button size="sm" disabled={props.interruptPending} onClick={props.onInterrupt}>
            Остановить ход
          </Button>
        )}
        <Button variant="danger" size="sm" disabled={props.finishPending} onClick={props.onFinish}>
          Завершить планирование
        </Button>
      </div>
      <AgentFeed feed={props.feed} status={props.feedStatus} error={props.feedError} />
      <div className="flex flex-col gap-2 border-t border-line py-3 text-sm">
        {props.dialogueSlot}
        {props.actionError && (
          <span className="text-xs text-danger-text" role="alert">
            {props.actionError}
          </span>
        )}
      </div>
    </main>
  );
}
