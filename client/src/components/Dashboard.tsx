import { useState } from "react";
import type { TaskView } from "../../../src/server/api-types.js";
import { useLastVisit } from "../last-visit.js";
import { useDigest, useTasks } from "../queries.js";
import { AgentPanel } from "./AgentPanel.js";
import { Digest } from "./Digest.js";
import { ReadyCard, StuckCard, TaskCard } from "./TaskCard.js";

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <>
      <h2 className="mt-5 mb-2 text-[13px] font-semibold tracking-wide text-neutral-500 uppercase">
        {title} ({count})
      </h2>
      <div className="flex flex-col gap-2">{count === 0 ? <div className="py-2 text-neutral-500 italic">пусто</div> : children}</div>
    </>
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

  return (
    <>
      <main className="mx-auto max-w-4xl px-4 pt-3 pb-20">
        <Digest
          since={since}
          digest={digest.data}
          onOpenRequest={(issueNumber) => {
            const task = data?.inProgress.find((candidate) => candidate.issueNumber === issueNumber);
            if (task) open(task, true);
          }}
        />
        {tasks.isError && (
          <div className="mt-3 text-sm text-red-600" role="alert">
            Задачи не загружены: {tasks.error.message}
          </div>
        )}
        <Section title="В работе" count={data?.inProgress.length ?? 0}>
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
        <Section title="Готовые Задачи, ждут Слот" count={data?.ready.length ?? 0}>
          {data?.ready.map((task) => (
            <ReadyCard key={task.issueNumber} task={task} />
          ))}
        </Section>
        <Section title="Тупики: ready-for-human" count={data?.stuck.length ?? 0}>
          {data?.stuck.map((task) => (
            <StuckCard key={task.issueNumber} task={task} now={now} />
          ))}
        </Section>
      </main>
      {selectedTask && data && (
        <>
          <div className="fixed inset-0 z-29 bg-black/25" onClick={() => setSelected(null)} />
          <div className="fixed top-0 right-0 z-30 flex h-screen w-[min(620px,100vw)] flex-col border-l border-neutral-300 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
            <AgentPanel task={selectedTask} maxQaRounds={data.maxQaRounds} answering={selected?.answering ?? false} onClose={() => setSelected(null)} />
          </div>
        </>
      )}
    </>
  );
}
