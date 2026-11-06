import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ServerEvent } from "../../src/server/api-types.js";
import { KEYS } from "./queries.js";

const MAX_BACKOFF_MS = 30_000;

// Keeps one WebSocket per tab and turns server events into refetches; reconnects with backoff.
export function useServerEvents(enabled: boolean): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const invalidateAll = () => {
      void queryClient.invalidateQueries({ queryKey: KEYS.tasks });
      void queryClient.invalidateQueries({ queryKey: KEYS.installation });
      void queryClient.invalidateQueries({ queryKey: ["digest"] });
    };

    const handle = (event: ServerEvent) => {
      switch (event.type) {
        case "hello":
          return;
        case "installation":
          queryClient.setQueryData(KEYS.installation, event.installation);
          return;
        case "transition":
        case "task":
        case "request":
          void queryClient.invalidateQueries({ queryKey: KEYS.tasks });
          void queryClient.invalidateQueries({ queryKey: ["digest"] });
          return;
        case "agent":
          // The Slot count follows the Agent state.
          void queryClient.invalidateQueries({ queryKey: KEYS.tasks });
          void queryClient.invalidateQueries({ queryKey: KEYS.installation });
          return;
      }
    };

    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        // Whatever happened while the socket was down is picked up by a full refetch.
        invalidateAll();
      };
      socket.onmessage = (message: MessageEvent<string>) => {
        try {
          handle(JSON.parse(message.data) as ServerEvent);
        } catch {
          // A malformed frame is ignored; the next refetch interval covers it.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt));
        attempt += 1;
      };
    };
    connect();

    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.close();
    };
  }, [enabled, queryClient]);

  return connected;
}
