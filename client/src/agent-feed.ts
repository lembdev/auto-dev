import { useEffect, useRef, useState } from "react";
import { applyMessage, applyMessages, emptyFeed, type FeedState } from "./feed.js";
import { liveFeeds } from "./live.js";
import type { AgentHistoryResponse } from "../../src/server/api-types.js";
import { fetchAgentHistory } from "./queries.js";

export type FeedStatus = "loading" | "live" | "error";

export type AgentFeedHook = { feed: FeedState; status: FeedStatus; error: string | null };

// The feed of one Agent of a Task: the Session history first, then the live stream from the seam
// the server named. It stays on that Agent when the Task moves on to the next one.
export function useAgentFeed(issueNumber: number, agentId: number | null): AgentFeedHook {
  return useSessionFeed(`task:${issueNumber}:agent:${agentId}`, agentId, () => fetchAgentHistory(issueNumber, agentId ?? 0));
}

// The same feed for any Session: `key` names whose history `load` fetches; a new key or Agent starts over.
export function useSessionFeed(key: string, agentId: number | null, load: () => Promise<AgentHistoryResponse>): AgentFeedHook {
  const [feed, setFeed] = useState<FeedState>(emptyFeed);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const current = useRef<FeedState>(feed);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const update = (next: FeedState) => {
      current.current = next;
      setFeed(next);
    };
    update(emptyFeed());
    setStatus("loading");
    setError(null);
    if (agentId === null) return;
    load()
      .then((response) => {
        if (cancelled) return;
        update(applyMessages(current.current, response.history));
        unsubscribe = liveFeeds.subscribe(response.agent.id, response.cursor, (entry) => {
          update(applyMessage(current.current, entry.message));
        });
        setStatus("live");
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // `load` is a new closure every render; `key` names what it loads.
  }, [key, agentId]);

  return { feed, status, error };
}
