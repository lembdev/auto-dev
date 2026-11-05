import { upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { Task, Transition } from "../index/tasks.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Ports } from "../ports/index.js";

export type AppDeps = {
  ports: Ports;
  index: RuntimeIndex;
  log: Logger;
  version: string;
  orchestrator: Pick<Orchestrator, "readyQueue" | "slots" | "findIssue" | "qa">;
};

export type HealthResponse = {
  status: "ok";
  version: string;
  schemaVersion: number;
  uptimeMs: number;
};

export type TaskView = Task & { htmlUrl: string | null; pullUrl: string | null; transitions: Transition[] };
// A Task that left the Pipeline, with the reason of its last transition.
export type FinishedTaskView = TaskView & { reason: string | null };
export type StuckTaskView = FinishedTaskView;
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
  cancelled: FinishedTaskView[];
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
      return { ...task, htmlUrl, pullUrl: pullUrlOf(htmlUrl, task.pullNumber), transitions: deps.index.transitions.listFor(task.issueNumber) };
    };
    const finished = (task: Task): FinishedTaskView => {
      const viewed = view(task);
      return { ...viewed, reason: viewed.transitions.at(-1)?.reason ?? null };
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
      stuck: deps.index.tasks.listByStage(["stuck"]).map(finished),
      cancelled: deps.index.tasks.listByStage(["cancelled"]).map(finished),
    };
    return c.json(body);
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
