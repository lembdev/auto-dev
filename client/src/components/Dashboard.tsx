import { useEffect, useMemo, useState } from "react";
import type { FinishedTaskView, TaskView, TasksResponse } from "../../../src/server/api-types.js";
import { useLastVisit } from "../last-visit.js";
import { focusNodeOf, isLive, pipelineOf } from "../pipeline.js";
import { useDigest, useTasks } from "../queries.js";
import { AgentPanel } from "./AgentPanel.js";
import { Digest } from "./Digest.js";
import { DoneCard, ReadyCard, StuckCard, TaskCard } from "./TaskCard.js";
import { Banner, cx, SectionTitle } from "./ui.js";

function Section({ title, count, empty, children }: { title: string; count: number; empty: string | null; children: React.ReactNode }) {
  if (count === 0 && empty === null) return null;
  return (
    <section className="mt-6">
      <SectionTitle count={count} className="mb-2.5">
        {title}
      </SectionTitle>
      {count === 0 ? <div className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">{empty}</div> : <div className="flex flex-col gap-2">{children}</div>}
    </section>
  );
}

// Which step's feed is open: a concrete node, so the panel stays on it while the Task moves on.
type Selection = { issueNumber: number; nodeKey: string | null; answering: boolean };

const findTask = (data: TasksResponse | undefined, issueNumber: number): TaskView | FinishedTaskView | undefined =>
  data?.inProgress.find((task) => task.issueNumber === issueNumber) ?? data?.stuck.find((task) => task.issueNumber === issueNumber) ?? data?.done.find((task) => task.issueNumber === issueNumber);

// Development mode: the digest, then the Tasks as rows of their Pipeline steps, with the feed of the
// chosen step in a side panel that leaves the board in sight.
export function Dashboard({ now }: { now: number }) {
  const since = useLastVisit();
  const tasks = useTasks(true);
  const digest = useDigest(since);
  const [selected, setSelected] = useState<Selection | null>(null);
  const data = tasks.data;

  const selectedTask = selected ? findTask(data, selected.issueNumber) : undefined;
  const pipeline = useMemo(() => (selectedTask ? pipelineOf(selectedTask) : undefined), [selectedTask]);
  const liveNode = pipeline?.nodes.find(isLive);
  const selectedNode = pipeline ? (pipeline.nodes.find((node) => node.key === selected?.nodeKey && node.agent !== null) ?? focusNodeOf(pipeline)) : undefined;
  const panelOpen = selectedTask !== undefined && selectedNode !== undefined;
  const keyOf = (issueNumber: number) => (panelOpen && selected?.issueNumber === issueNumber ? selectedNode.key : null);

  // A click on the card opens the live step, pinned by its key: the panel does not follow the Task further.
  const open = (task: TaskView, nodeKey?: string, answering = false) => setSelected({ issueNumber: task.issueNumber, nodeKey: nodeKey ?? focusNodeOf(pipelineOf(task))?.key ?? null, answering });

  // Escape closes the panel.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  return (
    <>
      <div className={cx("transition-[margin] duration-200", panelOpen && "lg:mr-[min(600px,45vw)]")}>
        <main className="mx-auto max-w-4xl px-4 pt-4 pb-20">
          <Digest
            since={since}
            digest={digest.data}
            onOpenRequest={(issueNumber) => {
              const task = data?.inProgress.find((candidate) => candidate.issueNumber === issueNumber);
              if (task) open(task, undefined, true);
            }}
          />
          {tasks.isError && (
            <Banner tone="danger" role="alert" className="mt-4">
              Задачи не загружены: {tasks.error.message}
            </Banner>
          )}
          <Section title="В работе" count={data?.inProgress.length ?? 0} empty="Агенты сейчас ничего не делают.">
            {data?.inProgress.map((task) => (
              <TaskCard
                key={task.issueNumber}
                task={task}
                maxQaRounds={data.maxQaRounds}
                now={now}
                selectedKey={keyOf(task.issueNumber)}
                onOpen={(candidate, nodeKey) => open(candidate, nodeKey)}
                onAnswer={(candidate) => open(candidate, undefined, true)}
              />
            ))}
          </Section>
          <Section title="Готовые Задачи, ждут Слот" count={data?.ready.length ?? 0} empty="Очередь пуста: нет issue с меткой ready-for-agent.">
            {data?.ready.map((task) => (
              <ReadyCard key={task.issueNumber} task={task} />
            ))}
          </Section>
          <Section title="Тупики: ready-for-human" count={data?.stuck.length ?? 0} empty="Тупиков нет.">
            {data?.stuck.map((task) => (
              <StuckCard key={task.issueNumber} task={task} now={now} selectedKey={keyOf(task.issueNumber)} onOpen={(candidate, nodeKey) => open(candidate, nodeKey)} />
            ))}
          </Section>
          <Section title="Влито за сутки" count={data?.done.length ?? 0} empty={null}>
            {data?.done.map((task) => (
              <DoneCard key={task.issueNumber} task={task} now={now} selectedKey={keyOf(task.issueNumber)} onOpen={(candidate, nodeKey) => open(candidate, nodeKey)} />
            ))}
          </Section>
        </main>
      </div>
      {panelOpen && data && (
        <>
          {/* On a narrow screen the panel covers the board, so a tap outside closes it. */}
          <div className="fixed inset-0 z-29 bg-black/30 lg:hidden" aria-hidden onClick={() => setSelected(null)} />
          <div className="fixed top-0 right-0 z-30 flex h-dvh w-[min(600px,100vw)] flex-col border-l border-line bg-surface shadow-2xl lg:w-[min(600px,45vw)] lg:shadow-none">
            <AgentPanel
              key={`${selectedTask.issueNumber}:${selectedNode.key}`}
              task={selectedTask}
              node={selectedNode}
              liveNode={liveNode}
              onJump={(nodeKey) => setSelected({ issueNumber: selectedTask.issueNumber, nodeKey, answering: false })}
              answering={selected?.answering ?? false}
              onClose={() => setSelected(null)}
            />
          </div>
        </>
      )}
    </>
  );
}
