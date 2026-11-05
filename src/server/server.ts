import { serve, type ServerType, type WebSocketServerLike } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { Logger } from "../log.js";
import type { App } from "./app.js";

export type StartServerOptions = {
  app: App;
  host: string;
  // 0 picks a free port; tests rely on it.
  port: number;
  log: Logger;
};

export type RunningServer = {
  address: AddressInfo;
  url: string;
  close(): Promise<void>;
};

// One Node http server carries both the REST API and the `/ws` upgrade.
export function startServer(options: StartServerOptions): Promise<RunningServer> {
  const wss = new WebSocketServer({ noServer: true });
  // The `ws` option types allow an explicit undefined where the adapter wants a plain boolean.
  const websocket = { server: wss as unknown as WebSocketServerLike };
  return new Promise((resolve, reject) => {
    let server: ServerType;
    const onError = (error: Error) => reject(error);
    server = serve(
      { fetch: options.app.fetch, hostname: options.host, port: options.port, websocket, overrideGlobalObjects: false },
      (address) => {
        server.off("error", onError);
        const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
        const url = `http://${host}:${address.port}`;
        options.log.info({ url }, "server listening");
        resolve({
          address,
          url,
          close: () =>
            new Promise<void>((done, fail) => {
              for (const client of wss.clients) client.terminate();
              wss.close();
              server.close((error) => (error ? fail(error) : done()));
            }),
        });
      },
    );
    server.once("error", onError);
  });
}
