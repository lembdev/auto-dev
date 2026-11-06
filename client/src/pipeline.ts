import type { AgentView, TaskView } from "../../src/server/api-types.js";
import type { TaskStage } from "../../src/index/tasks.js";

export type NodeStage = "implement" | "qa" | "merge";

// Where a node is: finished well or badly, the live one (by its Agent's state), or still ahead.
export type NodeStatus = "ok" | "rejected" | "failed" | "running" | "waiting" | "idle" | "pending";

// One step of a Task's Pipeline as the board draws it: a stint of the Implementer, a QA round, the Merge.
// Stints of the Implementer share its one Session, so they point at the same Agent.
export type PipelineNode = {
  key: string;
  stage: NodeStage;
  title: string;
  agent: AgentView | null;
  status: NodeStatus;
  // A short result once the node is finished: "одобрено", "3 замечания", "красные проверки".
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

// How the Task left the Pipeline, drawn after the last node.
export type PipelineEnd = "done" | "stuck" | "cancelled" | null;

export type Pipeline = { nodes: PipelineNode[]; end: PipelineEnd };

type Segment = { stage: NodeStage; startedAt: string; enterReason: string | null; endedAt: string | null; exitTo: TaskStage | null; exitReason: string | null };

const WORK_STAGES: readonly TaskStage[] = ["implement", "qa", "merge"];
const isWorkStage = (stage: TaskStage): stage is NodeStage => WORK_STAGES.includes(stage);

// Reasons the Orchestrator writes into the transitions (see qa.ts, merger.ts).
const EXTRA_ROUND = /extra qa round/;
const BLOCKERS = /: (\d+) blockers/;

const plural = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

function segmentsOf(task: TaskView): Segment[] {
  const segments: Segment[] = [];
  for (const transition of task.transitions) {
    if (transition.at < task.takenAt) continue;
    const last = segments.at(-1);
    if (last && last.endedAt === null) {
      // The Merger starting inside Merge is not a new step.
      if (transition.to === last.stage) continue;
      last.endedAt = transition.at;
      last.exitTo = transition.to;
      last.exitReason = transition.reason;
    }
    if (isWorkStage(transition.to)) segments.push({ stage: transition.to, startedAt: transition.at, enterReason: transition.reason, endedAt: null, exitTo: null, exitReason: null });
  }
  return segments;
}

function outcomeOf(segment: Segment): { status: NodeStatus; outcome: string | null } {
  const { exitTo, exitReason } = segment;
  if (exitTo === "stuck") return { status: "failed", outcome: "тупик" };
  if (exitTo === "cancelled") return { status: "failed", outcome: "отменена" };
  if (segment.stage === "qa") {
    if (exitTo === "merge" || exitTo === "done") return { status: "ok", outcome: "одобрено" };
    const blockers = exitReason ? BLOCKERS.exec(exitReason) : null;
    if (blockers) {
      const n = Number(blockers[1]);
      return { status: "rejected", outcome: `${n} ${plural(n, "замечание", "замечания", "замечаний")}` };
    }
    return { status: "ok", outcome: exitTo === "implement" ? "прервано сообщением" : null };
  }
  if (segment.stage === "merge") {
    if (exitTo === "done") return { status: "ok", outcome: "влито" };
    if (exitTo === "implement") return { status: "rejected", outcome: "красные проверки" };
    if (exitTo === "qa") return { status: "ok", outcome: "конфликт решён" };
    return { status: "ok", outcome: null };
  }
  return { status: "ok", outcome: exitTo === "qa" ? "готово" : null };
}

const liveStatus = (agent: AgentView | null): NodeStatus => {
  switch (agent?.state) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    default:
      // No Agent yet or a stopped one between Turns: the step is under way all the same.
      return "running";
  }
};

const inWindow = (agent: AgentView, segment: Segment): boolean => agent.createdAt >= segment.startedAt && (segment.endedAt === null || agent.createdAt < segment.endedAt);

// The Pipeline of the current attempt of a Task, from its transitions and its Agents.
export function pipelineOf(task: TaskView): Pipeline {
  const segments = segmentsOf(task);
  const agents = task.agents;
  const implementer = agents.find((agent) => agent.role === "implementer") ?? null;
  const active = WORK_STAGES.includes(task.stage) || task.stage === "taken";
  const nodes: PipelineNode[] = [];
  let qaRound = 0;
  let stints = 0;

  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    let title: string;
    let agent: AgentView | null;
    if (segment.stage === "implement") {
      stints += 1;
      title = stints === 1 ? "Реализация" : "Правки";
      agent = implementer;
    } else if (segment.stage === "qa") {
      const extra = segment.enterReason !== null && EXTRA_ROUND.test(segment.enterReason);
      if (!extra) qaRound += 1;
      title = extra ? "QA · доп. Круг" : `QA · Круг ${qaRound}`;
      agent = agents.filter((candidate) => candidate.role === "qa" && inWindow(candidate, segment)).at(-1) ?? null;
    } else {
      title = "Merge";
      agent = agents.filter((candidate) => candidate.role === "merger" && inWindow(candidate, segment)).at(-1) ?? null;
    }
    const live = last && active && segment.endedAt === null;
    const result = live ? { status: liveStatus(agent), outcome: null } : outcomeOf(segment);
    nodes.push({ key: `${segment.stage}-${index}`, stage: segment.stage, title, agent, ...result, startedAt: segment.startedAt, endedAt: segment.endedAt });
  });

  // A Task taken a moment ago has no transition into a work Stage yet; its first Agent is starting.
  if (nodes.length === 0 && active) {
    nodes.push({ key: "implement-0", stage: "implement", title: "Реализация", agent: implementer ?? task.agent, status: liveStatus(task.agent), outcome: null, startedAt: task.takenAt, endedAt: null });
  }

  if (active) {
    const current = nodes.at(-1)?.stage ?? "implement";
    if (current === "implement") nodes.push(pending("qa", `QA · Круг ${qaRound + 1}`));
    if (current !== "merge") nodes.push(pending("merge", "Merge"));
  }

  const end: PipelineEnd = task.stage === "done" || task.stage === "stuck" || task.stage === "cancelled" ? task.stage : null;
  return { nodes, end };
}

const pending = (stage: NodeStage, title: string): PipelineNode => ({ key: `${stage}-next`, stage, title, agent: null, status: "pending", outcome: null, startedAt: null, endedAt: null });

// The node the card opens by default: the live one, else the last one that has a feed.
export function focusNodeOf(pipeline: Pipeline): PipelineNode | undefined {
  const started = pipeline.nodes.filter((node) => node.status !== "pending");
  return started.findLast((node) => node.agent !== null) ?? started.at(-1);
}

export const isLive = (node: PipelineNode): boolean => node.status === "running" || node.status === "waiting" || node.status === "idle";
