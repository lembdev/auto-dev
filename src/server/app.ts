import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { ConfigStore } from "../config-store.js";
import type { AgentId } from "../ids.js";
import type { HumanRequest } from "../index/human-requests.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task, Transition } from "../index/tasks.js";
import { LogBuffer, type Logger, type LogSource } from "../log.js";
import { PAUSE_SOURCES, type PauseSource } from "../orchestrator/installation-state.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Ports } from "../ports/index.js";
import type { Settings } from "../setup/settings.js";
import type { Setup } from "../setup/setup.js";
import type {
  AgentView,
  ClientMessage,
  DigestResponse,
  FinishedTaskView,
  InstallationResponse,
  HealthResponse,
  PauseRequest,
  ProductView,
  ReadyTaskView,
  RequestView,
  ServerEvent,
  SessionResponse,
  TaskView,
  TasksResponse,
} from "./api-types.js";
import { registerStatsRoutes } from "./routes/stats.js";
import {
  clearSessionCookie,
  hasSession,
  hostCheck,
  SESSION_SECRET_KEY,
  sessionCheck,
  SessionCookies,
  setSessionCookie,
  verifyPassword,
} from "./auth.js";
import { isPublicSetupRequest, registerSetupRoutes } from "./setup-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { agentRoutes, agentView, currentAgentOf } from "./routes/agent.js";

export type {
  AgentFeedEntry,
  AgentHistoryResponse,
  AgentView,
  CancelResponse,
  ClientMessage,
  DigestResponse,
  InterruptResponse,
  FinishedTaskView,
  HealthResponse,
  InstallationResponse,
  LimitHistoryResponse,
  LogEntryView,
  LogsResponse,
  PauseRequest,
  ProductView,
  ReadyTaskView,
  RequestView,
  ServerEvent,
  SessionResponse,
  SettingsRequest,
  SettingsResponse,
  SetupAccessResponse,
  SetupOauthRequest,
  SetupPasswordRequest,
  SetupRepositoryRequest,
  SetupSmokeResponse,
  SetupStatus,
  SetupStepId,
  StatsResponse,
  StuckTaskView,
  TaskView,
  TasksResponse,
} from "./api-types.js";

export type AppDeps = {
  ports: Ports;
  index: RuntimeIndex;
  log: Logger;
  version: string;
  orchestrator: Pick<Orchestrator, "readyQueue" | "slots" | "findIssue" | "installation" | "qa" | "agents" | "humanRequests" | "reconcile">;
  // Live configuration: the password hash and the Product come from here on every request.
  config: ConfigStore;
  setup: Setup;
  settings: Settings;
  auth: { allowedHosts: readonly string[] };
  // Built client bundle; without it the server answers only the API.
  clientDir?: string;
  // Where `GET /api/logs` reads the journal tail from; an empty buffer when nothing is wired.
  logs?: LogSource;
};

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

export type App = Hono & {
  // Sends an event to every connected WebSocket client.
  broadcast(event: ServerEvent): void;
};

type Socket = { send(data: string): void; subscriptions: Map<number, () => void> };

const parseClientMessage = (raw: unknown): ClientMessage | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const message = raw as Record<string, unknown>;
  if (typeof message.agentId !== "number" || !Number.isInteger(message.agentId)) return undefined;
  if (message.type === "unsubscribe") return { type: "unsubscribe", agentId: message.agentId };
  if (message.type !== "subscribe") return undefined;
  if (message.after !== undefined && typeof message.after !== "number") return undefined;
  return { type: "subscribe", agentId: message.agentId, ...(message.after !== undefined ? { after: message.after } : {}) };
};

// GitHub addresses issues and pull requests under the same repository path.
const pullUrlOf = (issueUrl: string | null, pullNumber: number | null): string | null =>
  issueUrl === null || pullNumber === null ? null : issueUrl.replace(/\/issues\/\d+$/, `/pull/${pullNumber}`);

const commentUrlOf = (issueUrl: string | null, commentId: number | null): string | null =>
  issueUrl === null || commentId === null ? null : `${issueUrl}#issuecomment-${commentId}`;

// Keys of `installation` whose change the UI should see; cursors and secrets are not its business.
const isUiInstallationKey = (key: string): boolean => !key.startsWith("poll.") && key !== SESSION_SECRET_KEY;

// The HTTP and WebSocket API over the ports and the index. Tests hand it fakes and call it directly.
export function createApp(deps: AppDeps): App {
  const app = new Hono() as App;
  const sockets = new Set<Socket>();
  const bySocket = new WeakMap<object, Socket>();
  const startedAt = deps.ports.clock.now();
  const sessions = new SessionCookies(deps.index.installation, deps.ports.clock);
  const passwordHash = (): string | undefined => deps.config.current().passwordHash;
  const product = (): ProductView | null => {
    const github = deps.config.current().github;
    return github ? { fullName: `${github.owner}/${github.repo}`, htmlUrl: `https://github.com/${github.owner}/${github.repo}` } : null;
  };

  app.broadcast = (event) => {
    const data = JSON.stringify(event);
    for (const socket of sockets) {
      try {
        socket.send(data);
      } catch (error) {
        deps.log.warn({ err: error, event: event.type }, "ws send failed");
      }
    }
  };

  app.use("*", hostCheck(deps.auth.allowedHosts));
  app.use("/api/*", sessionCheck(sessions, deps.auth.allowedHosts, { isPublic: (c) => isPublicSetupRequest(c, passwordHash) }));
  app.use("/ws", sessionCheck(sessions, deps.auth.allowedHosts));

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: deps.version,
      schemaVersion: deps.index.schemaVersion(),
      uptimeMs: deps.ports.clock.now() - startedAt,
    };
    return c.json(body);
  });

  app.get("/api/session", (c) => {
    const body: SessionResponse = { authenticated: hasSession(c, sessions), passwordSet: passwordHash() !== undefined };
    return c.json(body);
  });

  app.post("/api/login", async (c) => {
    const hash = passwordHash();
    if (hash === undefined) return c.json({ error: "password is not set; finish the first-run wizard" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON with a string `password`" }, 400);
    }
    const password = typeof body === "object" && body !== null ? (body as Record<string, unknown>).password : undefined;
    if (typeof password !== "string") return c.json({ error: "body must be JSON with a string `password`" }, 400);
    if (!(await verifyPassword(hash, password))) {
      deps.log.warn({ ip: c.req.header("x-forwarded-for") ?? null }, "login rejected");
      return c.json({ error: "wrong password" }, 401);
    }
    setSessionCookie(c, sessions.issue().value);
    deps.log.info("login accepted");
    const response: SessionResponse = { authenticated: true, passwordSet: true };
    return c.json(response);
  });

  app.post("/api/logout", (c) => {
    clearSessionCookie(c);
    const response: SessionResponse = { authenticated: false, passwordSet: passwordHash() !== undefined };
    return c.json(response);
  });

  registerSetupRoutes(app, { setup: deps.setup, sessions, passwordHash, log: deps.log });
  registerSettingsRoutes(app, { settings: deps.settings });

  // Views

  const issueUrlOf = (task: Task): string | null => deps.orchestrator.findIssue(task.issueNumber)?.htmlUrl ?? null;

  const agentOf = (task: Task): AgentView | null => {
    const agent = currentAgentOf(deps.index.agents, task);
    return agent ? agentView(agent) : null;
  };

  const requestOf = async (task: Task, htmlUrl: string | null): Promise<RequestView | null> => {
    const request = deps.orchestrator.humanRequests.listOpen().find((candidate) => candidate.issueNumber === task.issueNumber);
    if (!request) return null;
    return requestView(request, htmlUrl);
  };

  const requestView = async (request: HumanRequest, htmlUrl: string | null): Promise<RequestView> => {
    const text = await deps.orchestrator.humanRequests.findText(request);
    return {
      id: request.id,
      agentId: request.agentId,
      commentId: request.commentId,
      commentUrl: commentUrlOf(htmlUrl, request.commentId),
      createdAt: request.createdAt,
      question: text?.question ?? null,
      options: text?.options ?? [],
    };
  };

  const taskView = async (task: Task): Promise<TaskView> => {
    const htmlUrl = issueUrlOf(task);
    return {
      ...task,
      htmlUrl,
      pullUrl: pullUrlOf(htmlUrl, task.pullNumber),
      transitions: deps.index.transitions.listFor(task.issueNumber),
      agent: agentOf(task),
      request: await requestOf(task, htmlUrl),
    };
  };

  const finishedView = async (task: Task): Promise<FinishedTaskView> => {
    const viewed = await taskView(task);
    const last = viewed.transitions.at(-1);
    return { ...viewed, reason: last?.reason ?? null, finishedAt: last?.at ?? null };
  };

  app.get("/api/tasks", async (c) => {
    const ready = deps.orchestrator.readyQueue();
    const body: TasksResponse = {
      slots: deps.orchestrator.slots(),
      maxQaRounds: deps.orchestrator.qa.maxRounds(),
      inProgress: await Promise.all(deps.index.tasks.listActive().map(taskView)),
      ready: ready.map(
        (issue): ReadyTaskView => ({
          issueNumber: issue.number,
          title: issue.title,
          milestone: issue.milestone ? { number: issue.milestone.number, title: issue.milestone.title } : null,
          htmlUrl: issue.htmlUrl,
        }),
      ),
      stuck: await Promise.all(deps.index.tasks.listByStage(["stuck"]).map(finishedView)),
      cancelled: await Promise.all(deps.index.tasks.listByStage(["cancelled"]).map(finishedView)),
    };
    return c.json(body);
  });

  const installationView = (): InstallationResponse => ({
    ...deps.orchestrator.installation.snapshot(),
    slots: deps.orchestrator.slots(),
    product: product(),
    version: deps.version,
  });

  app.get("/api/installation", (c) => c.json(installationView()));

  app.route("/api/tasks", agentRoutes({ ports: deps.ports, index: deps.index, log: deps.log, orchestrator: deps.orchestrator }));
  registerStatsRoutes(app, { index: deps.index, clock: deps.ports.clock, logs: deps.logs ?? new LogBuffer() });

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

  // Everything the human missed since `since`: Requests, finished Tasks and dead ends, newest last.
  app.get("/api/digest", async (c) => {
    const since = c.req.query("since");
    if (since === undefined || !Number.isFinite(Date.parse(since))) return c.json({ error: "`since` must be an ISO timestamp" }, 400);
    const titleOf = (issueNumber: Task["issueNumber"]): string | null => deps.index.tasks.find(issueNumber)?.title ?? null;
    const transitions = deps.index.transitions.listSince(since);
    const requests = await Promise.all(
      deps.index.humanRequests.listSince(since).map(async (request) => {
        const text = await deps.orchestrator.humanRequests.findText(request);
        return {
          id: request.id,
          issueNumber: request.issueNumber,
          title: titleOf(request.issueNumber),
          createdAt: request.createdAt,
          open: request.answeredAt === null,
          question: text?.question ?? null,
        };
      }),
    );
    const body: DigestResponse = {
      since,
      requests,
      done: lastPerIssue(transitions.filter((transition) => transition.to === "done")).map((transition) => {
        const task = deps.index.tasks.find(transition.issueNumber);
        const htmlUrl = task ? issueUrlOf(task) : null;
        return {
          issueNumber: transition.issueNumber,
          title: task?.title ?? null,
          pullNumber: task?.pullNumber ?? null,
          pullUrl: pullUrlOf(htmlUrl, task?.pullNumber ?? null),
          at: transition.at,
        };
      }),
      stuck: lastPerIssue(transitions.filter((transition) => transition.to === "stuck")).map((transition) => ({
        issueNumber: transition.issueNumber,
        title: titleOf(transition.issueNumber),
        reason: transition.reason,
        at: transition.at,
      })),
    };
    return c.json(body);
  });

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        const socket: Socket = { send: (data) => ws.send(data), subscriptions: new Map() };
        sockets.add(socket);
        bySocket.set(ws, socket);
        deps.log.debug({ clients: sockets.size }, "ws client connected");
        socket.send(JSON.stringify({ type: "hello", version: deps.version } satisfies ServerEvent));
      },
      onMessage(event, ws) {
        const socket = bySocket.get(ws);
        if (!socket || typeof event.data !== "string") return;
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          return;
        }
        const message = parseClientMessage(raw);
        if (!message) {
          deps.log.debug({ frame: event.data.slice(0, 200) }, "ws frame ignored");
          return;
        }
        socket.subscriptions.get(message.agentId)?.();
        socket.subscriptions.delete(message.agentId);
        if (message.type === "unsubscribe") return;
        socket.subscriptions.set(message.agentId, subscribeFeed(socket, message.agentId as AgentId, message.after ?? 0));
      },
      onClose(_event, ws) {
        const socket = bySocket.get(ws);
        if (socket) {
          for (const unsubscribe of socket.subscriptions.values()) unsubscribe();
          sockets.delete(socket);
          bySocket.delete(ws);
        }
        deps.log.debug({ clients: sockets.size }, "ws client disconnected");
      },
    })),
  );

  // The buffered tail after `after` goes out first, then every new message; the watermark keeps
  // the two from overlapping. Pushes come from the Agent process in later ticks, never in between.
  function subscribeFeed(socket: Socket, agentId: AgentId, after: number): () => void {
    const feed = deps.orchestrator.agents.feed;
    let watermark = after;
    const forward = (seq: number, message: ServerEvent & { type: "agent-message" }): void => {
      if (seq <= watermark) return;
      watermark = seq;
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        deps.log.warn({ err: error, agent: agentId }, "ws send failed");
      }
    };
    for (const entry of feed.after(agentId, after)) forward(entry.seq, { type: "agent-message", agentId, seq: entry.seq, message: entry.message });
    return feed.subscribe(agentId, (_, entry) => forward(entry.seq, { type: "agent-message", agentId, seq: entry.seq, message: entry.message }));
  }

  // Index changes reach every open tab; the client refetches what the event names.
  deps.index.transitions.onAppend((transition: Transition) =>
    app.broadcast({ type: "transition", issueNumber: transition.issueNumber, from: transition.from, to: transition.to, reason: transition.reason, at: transition.at }),
  );
  deps.index.tasks.onChange((task) => app.broadcast({ type: "task", issueNumber: task.issueNumber, stage: task.stage, round: task.round }));
  deps.orchestrator.agents.onStateChange((agent, previous) =>
    app.broadcast({ type: "agent", agentId: agent.id, issueNumber: agent.issueNumber, role: agent.role, state: agent.state, previous }),
  );
  deps.index.humanRequests.onChange((request) =>
    app.broadcast({ type: "request", requestId: request.id, issueNumber: request.issueNumber, open: request.answeredAt === null }),
  );
  deps.index.installation.onChange((key) => {
    if (isUiInstallationKey(key)) app.broadcast({ type: "installation", installation: installationView() });
  });
  // A stored repository changes the Product in the header.
  deps.config.onChange(() => app.broadcast({ type: "installation", installation: installationView() }));

  if (deps.clientDir !== undefined) {
    const clientDir = deps.clientDir;
    app.use("/*", serveStatic({ root: clientDir }));
    // Any other path is a route of the SPA; the API keeps its JSON 404.
    const index = serveStatic({ root: clientDir, path: "index.html" });
    app.get("*", (c, next) => (c.req.path.startsWith("/api/") || c.req.path === "/ws" ? next() : index(c, next)));
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((error, c) => {
    deps.log.error({ err: error, path: c.req.path }, "request failed");
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

// A Task can enter the same Stage twice between visits; the digest names it once, by the latest entry.
const lastPerIssue = (transitions: Transition[]): Transition[] => {
  const byIssue = new Map<number, Transition>();
  for (const transition of transitions) byIssue.set(transition.issueNumber, transition);
  return [...byIssue.values()];
};
