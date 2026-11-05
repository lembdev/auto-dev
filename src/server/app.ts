import { upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { Task } from "../index/tasks.js";
import { PAUSE_SOURCES, type InstallationSnapshot, type PauseSource } from "../orchestrator/installation-state.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Ports } from "../ports/index.js";

export type AppDeps = {
  ports: Ports;
  index: RuntimeIndex;
  log: Logger;
  version: string;
  orchestrator: Pick<Orchestrator, "readyQueue" | "slots" | "findIssue" | "installation" | "qa">;
};

export type HealthResponse = {
  status: "ok";
  version: string;
  schemaVersion: number;
  uptimeMs: number;
};

export type TaskView = Task & { htmlUrl: string | null; pullUrl: string | null };
export type StuckTaskView = TaskView & { reason: string | null };
export type ReadyTaskView = {
  issueNumber: number;
  title: string;
  milestone: { number: number; title: string } | null;
  htmlUrl: string;
};

export type TasksResponse = {
  slots: { used: number; max: number };
  // Limit of QA rounds; a Task in `qa` is in round `round + 1` of it.
  maxQaRounds: number;
  inProgress: TaskView[];
  ready: ReadyTaskView[];
  stuck: StuckTaskView[];
};

export type InstallationResponse = InstallationSnapshot & { slots: { used: number; max: number } };

// Body of `PUT /api/installation/pause`: a human pauses or resumes the Installation.
export type PauseRequest = { paused: boolean; reason?: string; source?: PauseSource };

export const DEFAULT_PAUSE_REASON = "paused from the UI";

const parsePauseRequest = (body: unknown): PauseRequest | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as Record<string, unknown>;
  if (typeof raw.paused !== "boolean") return undefined;
  if (raw.reason !== undefined && typeof raw.reason !== "string") return undefined;
  if (raw.source !== undefined && !PAUSE_SOURCES.includes(raw.source as PauseSource)) return undefined;
  return {
    paused: raw.paused,
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    ...(raw.source !== undefined ? { source: raw.source as PauseSource } : {}),
  };
};

// Events pushed to the UI over `/ws`; later tickets extend the union.
export type ServerEvent = { type: "hello"; version: string };

export type App = Hono & {
  // Sends an event to every connected WebSocket client.
  broadcast(event: ServerEvent): void;
};

type Socket = { send(data: string): void };

// GitHub addresses issues and pull requests under the same repository path.
const pullUrlOf = (issueUrl: string | null, pullNumber: number | null): string | null =>
  issueUrl === null || pullNumber === null ? null : issueUrl.replace(/\/issues\/\d+$/, `/pull/${pullNumber}`);

// The HTTP and WebSocket API over the ports and the index. Tests hand it fakes and call it directly.
export function createApp(deps: AppDeps): App {
  const app = new Hono() as App;
  const sockets = new Set<Socket>();
  const bySocket = new WeakMap<object, Socket>();
  const startedAt = deps.ports.clock.now();

  app.broadcast = (event) => {
    const data = JSON.stringify(event);
    for (const socket of sockets) socket.send(data);
  };

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: deps.version,
      schemaVersion: deps.index.schemaVersion(),
      uptimeMs: deps.ports.clock.now() - startedAt,
    };
    return c.json(body);
  });

  app.get("/api/tasks", (c) => {
    const ready = deps.orchestrator.readyQueue();
    const view = (task: Task): TaskView => {
      const htmlUrl = deps.orchestrator.findIssue(task.issueNumber)?.htmlUrl ?? null;
      return { ...task, htmlUrl, pullUrl: pullUrlOf(htmlUrl, task.pullNumber) };
    };
    const body: TasksResponse = {
      slots: deps.orchestrator.slots(),
      maxQaRounds: deps.orchestrator.qa.maxRounds(),
      inProgress: deps.index.tasks.listActive().map(view),
      ready: ready.map((issue) => ({
        issueNumber: issue.number,
        title: issue.title,
        milestone: issue.milestone ? { number: issue.milestone.number, title: issue.milestone.title } : null,
        htmlUrl: issue.htmlUrl,
      })),
      stuck: deps.index.tasks.listByStage(["stuck"]).map((task) => ({
        ...view(task),
        reason: deps.index.transitions.listFor(task.issueNumber).at(-1)?.reason ?? null,
      })),
    };
    return c.json(body);
  });

  const installationView = (): InstallationResponse => ({
    ...deps.orchestrator.installation.snapshot(),
    slots: deps.orchestrator.slots(),
  });

  app.get("/api/installation", (c) => c.json(installationView()));

  app.put("/api/installation/pause", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON with a boolean `paused`" }, 400);
    }
    const request = parsePauseRequest(body);
    if (!request) return c.json({ error: "body must be JSON with a boolean `paused`, optional string `reason`" }, 400);
    const installation = deps.orchestrator.installation;
    if (request.paused) installation.pause(request.source ?? "human", request.reason ?? DEFAULT_PAUSE_REASON);
    else installation.unpause();
    return c.json(installationView());
  });

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        const socket: Socket = { send: (data) => ws.send(data) };
        sockets.add(socket);
        bySocket.set(ws, socket);
        deps.log.debug({ clients: sockets.size }, "ws client connected");
        socket.send(JSON.stringify({ type: "hello", version: deps.version } satisfies ServerEvent));
      },
      onClose(_event, ws) {
        const socket = bySocket.get(ws);
        if (socket) {
          sockets.delete(socket);
          bySocket.delete(ws);
        }
        deps.log.debug({ clients: sockets.size }, "ws client disconnected");
      },
    })),
  );

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((error, c) => {
    deps.log.error({ err: error, path: c.req.path }, "request failed");
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
