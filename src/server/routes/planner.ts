import { Hono } from "hono";
import type { RuntimeIndex } from "../../index/runtime-index.js";
import type { Logger } from "../../log.js";
import type { StartBlocker } from "../../orchestrator/installation-state.js";
import type { Orchestrator } from "../../orchestrator/orchestrator.js";
import {
  PLANNER_MODES,
  PlannerBusyError,
  PlannerOnHoldError,
  PlannerSessionNotFoundError,
  ProductNotClonedError,
  type PlannerLineId,
  type StartPlanner,
} from "../../orchestrator/planner.js";
import type { Ports } from "../../ports/index.js";
import type { AgentHistoryResponse, PlannerResponse, RemovePlannerLineResponse } from "../api-types.js";
import { agentView } from "./agent.js";

export type PlannerRoutesDeps = {
  ports: Ports;
  index: RuntimeIndex;
  log: Logger;
  orchestrator: Pick<Orchestrator, "planner" | "agents">;
};

const ON_HOLD_REASONS: Record<StartBlocker, string> = {
  paused: "Установка на Паузе",
  at_limit: "Установка у стены лимита подписки",
  prearm: "лимит подписки почти исчерпан (пре-арм)",
  claude_version: "версия Claude Code не прошла проверку",
};

const parseStart = (body: unknown): StartPlanner | string => {
  if (typeof body !== "object" || body === null) return "the body must be a JSON object";
  const raw = body as Record<string, unknown>;
  if (!PLANNER_MODES.includes(raw.mode as StartPlanner["mode"])) return '`mode` must be "resume" or "new"';
  if (raw.message !== undefined && typeof raw.message !== "string") return "`message` must be a string";
  return { mode: raw.mode as StartPlanner["mode"], ...(typeof raw.message === "string" ? { message: raw.message } : {}) };
};

// The planning mode under `/api/planner`: its state, start and finish, the transcript of the Session
// and the lines waiting for the end of a Turn. The lines themselves travel over `/ws` as Dialogue frames
// addressed to the Planner, with an ACK each.
export function plannerRoutes(deps: PlannerRoutesDeps): Hono {
  const routes = new Hono();
  const planner = () => deps.orchestrator.planner;

  const view = (): PlannerResponse => {
    const snapshot = planner().snapshot();
    return {
      status: snapshot.status,
      open: snapshot.open,
      canResume: planner().findPreviousSession() !== undefined,
      agent: snapshot.agent ? agentView(snapshot.agent) : null,
      sessionId: snapshot.agent?.sessionId ?? null,
      queue: snapshot.queue.map((line) => ({ id: line.id, clientId: line.clientId, seq: line.seq, text: line.text, createdAt: line.createdAt })),
    };
  };

  routes.get("/", (c) => c.json(view()));

  routes.post("/start", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "the body must be JSON" }, 400);
    }
    const spec = parseStart(body);
    if (typeof spec === "string") return c.json({ error: spec }, 400);
    try {
      await planner().start(spec);
    } catch (error) {
      if (error instanceof PlannerBusyError) return c.json({ error: "Планировщик уже запущен" }, 409);
      if (error instanceof PlannerOnHoldError) return c.json({ error: `Новые Ходы сейчас не стартуют: ${ON_HOLD_REASONS[error.blocker]}` }, 409);
      if (error instanceof PlannerSessionNotFoundError) return c.json({ error: "Прошлой Сессии планирования нет" }, 404);
      if (error instanceof ProductNotClonedError) return c.json({ error: "Продукт ещё не склонирован" }, 409);
      throw error;
    }
    return c.json(view());
  });

  routes.post("/finish", async (c) => {
    await planner().finish();
    return c.json(view());
  });

  routes.post("/interrupt", async (c) => {
    const agent = await planner().interrupt();
    if (!agent) return c.json({ error: "Планировщик сейчас не выполняет Ход" }, 409);
    return c.json(view());
  });

  // The transcript of the Planner's Session, the open one or the last; the feed continues after `cursor`.
  routes.get("/history", async (c) => {
    const agent = planner().current() ?? planner().findPreviousSession();
    if (!agent) return c.json({ error: "there is no planning Session yet" }, 404);
    let history: AgentHistoryResponse["history"] = [];
    if (agent.sessionId !== null) {
      try {
        history = await deps.ports.driver.getSessionHistory(agent.sessionId, { cwd: agent.cwd });
      } catch (error) {
        deps.log.warn({ err: error, agent: agent.id, session: agent.sessionId }, "planner session history unavailable");
      }
    }
    const body: AgentHistoryResponse = {
      agent: agentView(agent),
      sessionId: agent.sessionId,
      history,
      cursor: deps.orchestrator.agents.feed.cursorFor(agent.id, history),
    };
    return c.json(body);
  });

  routes.delete("/queue/:id", (c) => {
    const id = Number(c.req.param("id")) as PlannerLineId;
    if (!Number.isInteger(id) || id <= 0 || planner().remove(id) === "not-found") return c.json({ error: "line not found" }, 404);
    const body: RemovePlannerLineResponse = { id };
    return c.json(body);
  });

  return routes;
}
