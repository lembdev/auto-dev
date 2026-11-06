import type { AgentRecord, AgentStore } from "../index/agents.js";
import type { Task } from "../index/tasks.js";

// The latest Agent of the current attempt of a Task: the one the card, the panel and the Dialogue are about.
export const currentAgentOf = (agents: AgentStore, task: Task): AgentRecord | undefined =>
  agents
    .listByIssue(task.issueNumber)
    .filter((candidate) => candidate.createdAt >= task.takenAt)
    .at(-1);
