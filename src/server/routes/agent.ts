import { Hono } from "hono";
import type { AgentRunner } from "../../agents/agent-runner.js";
import type { AgentId, IssueNumber } from "../../ids.js";
import type { AgentRecord } from "../../index/agents.js";
import type { RuntimeIndex } from "../../index/runtime-index.js";
import { isActiveStage, type Task } from "../../index/tasks.js";
import type { Logger } from "../../log.js";
import type { Orchestrator } from "../../orchestrator/orchestrator.js";
import type { Ports } from "../../ports/index.js";
import type { AgentHistoryResponse, AgentView, CancelResponse, InterruptResponse } from "../api-types.js";
import { currentAgentOf } from "../../orchestrator/current-agent.js";

export type AgentRoutesDeps = {
  ports: Ports;
  index: RuntimeIndex;
  log: Logger;
  orchestrator: Pick<Orchestrator, "agents" | "reconcile">;
};

export { currentAgentOf } from "../../orchestrator/current-agent.js";

export const agentView = (agent: AgentRecord): AgentView => ({
  id: agent.id,
  role: agent.role,
  state: agent.state,
  lastTurnAt: agent.lastTurnAt,
  createdAt: agent.createdAt,
});

// The reason a human closes the issue from the panel; the Cancellation itself is the Reconciler's.
export const CANCEL_STATE_REASON = "not_planned";

const parseIssueNumber = (raw: string): IssueNumber | undefined => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? (parsed as IssueNumber) : undefined;
};

// Routes of one Task's Agent, mounted under `/api/tasks`: the Session history for the panel,
// interrupting the Turn and cancelling the Task by closing its issue.
export function agentRoutes(deps: AgentRoutesDeps): Hono {
  const routes = new Hono();
  const runner: AgentRunner = deps.orchestrator.agents;

  const taskOf = (raw: string): Task | undefined => {
    const issueNumber = parseIssueNumber(raw);
    return issueNumber === undefined ? undefined : deps.index.tasks.find(issueNumber);
  };

  const historyOf = async (agent: AgentRecord): Promise<AgentHistoryResponse> => {
    let history: AgentHistoryResponse["history"] = [];
    if (agent.sessionId !== null) {
      try {
        history = await deps.ports.driver.getSessionHistory(agent.sessionId, { cwd: agent.cwd });
      } catch (error) {
        // A Session whose transcript is not on disk yet (or any more) still has its live tail.
        deps.log.warn({ err: error, agent: agent.id, session: agent.sessionId }, "session history unavailable");
      }
    }
    return {
      agent: agentView(agent),
      sessionId: agent.sessionId,
      history,
      cursor: runner.feed.cursorFor(agent.id, history),
    };
  };

  routes.get("/:issue/agent/history", async (c) => {
    const task = taskOf(c.req.param("issue"));
    if (!task) return c.json({ error: "task not found" }, 404);
    const agent = currentAgentOf(deps.index.agents, task);
    if (!agent) return c.json({ error: "the Task has no Agent yet" }, 404);
    return c.json(await historyOf(agent));
  });

  // Any Agent of the Task, the finished ones included: a node of the Pipeline keeps its own feed.
  routes.get("/:issue/agents/:agentId/history", async (c) => {
    const task = taskOf(c.req.param("issue"));
    if (!task) return c.json({ error: "task not found" }, 404);
    const agentId = Number(c.req.param("agentId"));
    const agent = Number.isInteger(agentId) ? deps.index.agents.find(agentId as AgentId) : undefined;
    if (!agent || agent.issueNumber !== task.issueNumber) return c.json({ error: "agent not found" }, 404);
    return c.json(await historyOf(agent));
  });

  routes.post("/:issue/agent/interrupt", async (c) => {
    const task = taskOf(c.req.param("issue"));
    if (!task) return c.json({ error: "task not found" }, 404);
    const agent = currentAgentOf(deps.index.agents, task);
    if (!agent) return c.json({ error: "the Task has no Agent yet" }, 404);
    if (agent.state !== "running" || !runner.isLive(agent.id)) return c.json({ error: `the Agent is ${agent.state}, not running a Turn` }, 409);
    await runner.interrupt(agent.id);
    deps.log.info({ issue: task.issueNumber, agent: agent.id }, "turn interrupted from the UI");
    const body: InterruptResponse = { agent: agentView(deps.index.agents.get(agent.id)) };
    return c.json(body);
  });

  routes.post("/:issue/cancel", async (c) => {
    const task = taskOf(c.req.param("issue"));
    if (!task) return c.json({ error: "task not found" }, 404);
    if (!isActiveStage(task.stage) && task.stage !== "stuck") return c.json({ error: `the Task is ${task.stage}; nothing to cancel` }, 409);
    await deps.ports.github.updateIssue(task.issueNumber, { state: "closed", stateReason: CANCEL_STATE_REASON });
    deps.log.info({ issue: task.issueNumber, stage: task.stage }, "issue closed from the UI");
    await deps.orchestrator.reconcile(task.issueNumber);
    const body: CancelResponse = { issueNumber: task.issueNumber, stage: deps.index.tasks.get(task.issueNumber).stage };
    return c.json(body);
  });

  return routes;
}
