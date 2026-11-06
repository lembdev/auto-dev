import type { AgentRecord, AgentStore } from "../index/agents.js";
import type { Task } from "../index/tasks.js";

// Agents of the current attempt of a Task, oldest first: the Implementer, each QA round, the Merger.
export const attemptAgentsOf = (agents: AgentStore, task: Task): AgentRecord[] =>
  agents.listByIssue(task.issueNumber).filter((candidate) => candidate.createdAt >= task.takenAt);

// The Agent of the current attempt a Task is about: the card, the panel and the Dialogue. Back in
// Implementation after a QA round it is the Implementer again, whose one Session outlives the QA Agents;
// otherwise it is the latest Agent.
export const currentAgentOf = (agents: AgentStore, task: Task): AgentRecord | undefined => {
  const attempt = attemptAgentsOf(agents, task);
  if (task.stage === "implement") {
    const implementer = attempt.find((candidate) => candidate.role === "implementer");
    if (implementer) return implementer;
  }
  return attempt.at(-1);
};
