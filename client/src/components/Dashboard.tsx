import { useEffect, useState } from "react";
import type { TaskView } from "../../../src/server/api-types.js";
import { useLastVisit } from "../last-visit.js";
import { useDigest, useTasks } from "../queries.js";
import { AgentPanel } from "./AgentPanel.js";
import { Digest } from "./Digest.js";
import { ReadyCard, StuckCard, TaskCard } from "./TaskCard.js";
import { Banner, SectionTitle } from "./ui.js";

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <SectionTitle count={count} className="mb-2.5">
        {title}
      </SectionTitle>
      {count === 0 ? <div className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">{empty}</div> : <div className="flex flex-col gap-2">{children}</div>}
    </section>
  );
}

// Development mode: the digest, then one column of cards with the Agent panel as a drawer.
export function Dashboard({ now }: { now: number }) {
  const since = useLastVisit();
  const tasks = useTasks(true);
  const digest = useDigest(since);
  const [selected, setSelected] = useState<{ issueNumber: number; answering: boolean } | null>(null);
  const data = tasks.data;
  const selectedTask = selected ? data?.inProgress.find((task) => task.issueNumber === selected.issueNumber) : undefined;
  const open = (task: TaskView, answering = false) => setSelected({ issueNumber: task.issueNumber, answering });
  const drawerOpen = selectedTask !== undefined && data !== undefined;

  // Escape closes the drawer, like any other modal.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <>
      <main className="mx-auto max-w-4xl px-4 pt-4 pb-20">
        <Digest
          since={since}
          digest={digest.data}
          onOpenRequest={(issueNumber) => {
            const task = data?.inProgress.find((candidate) => candidate.issueNumber === issueNumber);
            if (task) open(task, true);
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
              selected={selected?.issueNumber === task.issueNumber}
              onOpen={(candidate) => open(candidate)}
              onAnswer={(candidate) => open(candidate, true)}
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
            <StuckCard key={task.issueNumber} task={task} now={now} />
          ))}
        </Section>
      </main>
      {selectedTask && data && (
        <>
          <div className="fixed inset-0 z-29 bg-black/30 backdrop-blur-[1px]" aria-hidden onClick={() => setSelected(null)} />
          <div className="fixed top-0 right-0 z-30 flex h-dvh w-[min(640px,100vw)] flex-col border-l border-line bg-surface shadow-2xl">
            <AgentPanel task={selectedTask} maxQaRounds={data.maxQaRounds} answering={selected?.answering ?? false} onClose={() => setSelected(null)} />
          </div>
        </>
      )}
    </>
  );
}
