import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ServerEvent } from "../../src/server/api-types.js";
import { dialogueOutbox } from "./dialogue.js";
import { liveFeeds } from "./live.js";
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
    // Set by the outbox when a frame waited too long for its ACK: the next close reconnects at once.
    let forced = false;

    const invalidateAll = () => {
      void queryClient.invalidateQueries({ queryKey: KEYS.tasks });
      void queryClient.invalidateQueries({ queryKey: KEYS.installation });
      void queryClient.invalidateQueries({ queryKey: ["digest"] });
      void queryClient.invalidateQueries({ queryKey: KEYS.planner });
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
        case "agent-message":
          liveFeeds.dispatch(event);
          return;
        case "dialogue":
          void queryClient.invalidateQueries({ queryKey: KEYS.dialogue(event.issueNumber) });
          return;
        case "planner":
          void queryClient.invalidateQueries({ queryKey: KEYS.planner });
          return;
        case "ack":
          dialogueOutbox.dispatch(event);
          return;
      }
    };

    const reconnect = () => {
      forced = true;
      socket?.close();
    };

    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        if (socket) {
          liveFeeds.attach(socket);
          dialogueOutbox.attach(socket, reconnect);
        }
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
        liveFeeds.detach();
        dialogueOutbox.detach();
        setConnected(false);
        if (closed) return;
        if (forced) {
          forced = false;
          connect();
          return;
        }
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
