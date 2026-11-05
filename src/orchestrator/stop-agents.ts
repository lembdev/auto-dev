import type { AgentRunner } from "../agents/agent-runner.js";
import type { IssueNumber } from "../ids.js";
import type { AgentStore } from "../index/agents.js";

// Terminates every live Agent process of the issue; Sessions stay on disk for a later resume or review.
export const stopAgentsOf = async (runner: AgentRunner, agents: AgentStore, issueNumber: IssueNumber): Promise<void> => {
  await Promise.all(
    agents
      .listByIssue(issueNumber)
      .filter((agent) => runner.isLive(agent.id))
      .map((agent) => runner.stop(agent.id)),
  );
};
