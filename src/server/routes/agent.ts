import { Hono } from "hono";
import type { AgentRunner } from "../../agents/agent-runner.js";
import type { AgentId, IssueNumber } from "../../ids.js";
import type { AgentRecord } from "../../index/agents.js";
import type { RuntimeIndex } from "../../index/runtime-index.js";
import { isActiveStage, type Task } from "../../index/tasks.js";
import type { Logger } from "../../log.js";
import type { Orchestrator } from "../../orchestrator/orchestrator.js";
import type { Ports } from "../../ports/index.js";
import type { DeadEndQuestionResult } from "../../orchestrator/dead-end-questions.js";
import type { AgentHistoryResponse, AgentView, AskAgentResponse, CancelResponse, InterruptResponse } from "../api-types.js";
import { currentAgentOf } from "../../orchestrator/current-agent.js";
import type { StartBlocker } from "../../orchestrator/installation-state.js";

export type AgentRoutesDeps = {
  ports: Ports;
  index: RuntimeIndex;
  log: Logger;
  orchestrator: Pick<Orchestrator, "agents" | "reconcile" | "deadEndQuestions">;
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

// Why no new Turn may start now, in the words of the UI: a Planner start and a question to an Agent.
export const ON_HOLD_REASONS: Record<StartBlocker, string> = {
  paused: "Установка на Паузе",
  at_limit: "Установка у стены лимита подписки",
  prearm: "лимит подписки почти исчерпан (пре-арм)",
  claude_version: "версия Claude Code не прошла проверку",
};

// Why a question about a dead end was not sent, in the words the panel shows.
const refusalOf = (result: Extract<DeadEndQuestionResult, { kind: "refused" }>): { status: 404 | 409; error: string } => {
  switch (result.reason) {
    case "not-found":
      return { status: 404, error: "Задача не найдена" };
    case "not-stuck":
      return { status: 409, error: "Задача не в Тупике" };
    case "no-agent":
      return { status: 409, error: "у Задачи нет Агента" };
    case "no-session":
      return { status: 409, error: "у Агента нет Сессии: продолжать нечего" };
    case "busy":
      return { status: 409, error: "Агент уже отвечает" };
    case "on-hold":
      return { status: 409, error: `новые Ходы сейчас не стартуют: ${ON_HOLD_REASONS[result.blocker]}` };
  }
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

  // A question to the Agent of the last step of a Task in a dead end: one Turn in its Session, no transition.
  routes.post("/:issue/agent/ask", async (c) => {
    const issueNumber = parseIssueNumber(c.req.param("issue"));
    if (issueNumber === undefined) return c.json({ error: "task not found" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "the body must be JSON" }, 400);
    }
    const text = typeof body === "object" && body !== null ? (body as Record<string, unknown>).text : undefined;
    if (typeof text !== "string" || text.trim() === "") return c.json({ error: "`text` must be a non-empty string" }, 400);
    const result = deps.orchestrator.deadEndQuestions.ask(issueNumber, text);
    if (result.kind === "refused") {
      const refusal = refusalOf(result);
      return c.json({ error: refusal.error }, refusal.status);
    }
    const response: AskAgentResponse = { agent: agentView(result.agent) };
    return c.json(response);
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
