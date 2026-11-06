import { useEffect, useRef, useState } from "react";
import { applyMessage, applyMessages, emptyFeed, type FeedState } from "./feed.js";
import { liveFeeds } from "./live.js";
import { fetchAgentHistory } from "./queries.js";

export type FeedStatus = "loading" | "live" | "error";

export type AgentFeedHook = { feed: FeedState; status: FeedStatus; error: string | null };

// The feed of the Agent of a Task: the Session history first, then the live stream from the seam
// the server named. A new Agent of the same Task (the QA Agent after the Implementer) starts over.
export function useAgentFeed(issueNumber: number, agentId: number | null): AgentFeedHook {
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
    fetchAgentHistory(issueNumber)
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
  }, [issueNumber, agentId]);

  return { feed, status, error };
}
