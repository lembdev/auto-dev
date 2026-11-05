import { upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { Ports } from "../ports/index.js";

export type AppDeps = {
  ports: Ports;
  index: RuntimeIndex;
  log: Logger;
  version: string;
};

export type HealthResponse = {
  status: "ok";
  version: string;
  schemaVersion: number;
  uptimeMs: number;
};

// Events pushed to the UI over `/ws`; later tickets extend the union.
export type ServerEvent = { type: "hello"; version: string };

export type App = Hono & {
  // Sends an event to every connected WebSocket client.
  broadcast(event: ServerEvent): void;
};

type Socket = { send(data: string): void };

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
