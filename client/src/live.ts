import type { AgentId } from "../../src/ids.js";
import type { AgentFeedEntry, ClientMessage, ServerEvent } from "../../src/server/api-types.js";

export type FeedListener = (entry: AgentFeedEntry) => void;

type Subscription = { after: number; listeners: Set<FeedListener> };

type SocketLike = { readyState: number; send(data: string): void };

const OPEN = 1;

// Live feeds of Agents over the one WebSocket of the tab. A subscription names the last `seq` it
// has, so a reconnect asks the server for what was missed and never for what is already shown.
export class LiveFeeds {
  private _socket: SocketLike | undefined;
  private readonly _subscriptions = new Map<AgentId, Subscription>();

  attach(socket: SocketLike): void {
    this._socket = socket;
    for (const [agentId, subscription] of this._subscriptions) this._send({ type: "subscribe", agentId, after: subscription.after });
  }

  detach(): void {
    this._socket = undefined;
  }

  // Routes one server event to the subscribers of its Agent; other events are not its business.
  dispatch(event: ServerEvent): void {
    if (event.type !== "agent-message") return;
    const subscription = this._subscriptions.get(event.agentId);
    if (!subscription || event.seq <= subscription.after) return;
    subscription.after = event.seq;
    for (const listener of subscription.listeners) listener({ seq: event.seq, message: event.message });
  }

  subscribe(agentId: AgentId, after: number, listener: FeedListener): () => void {
    const existing = this._subscriptions.get(agentId);
    if (existing) {
      // One drawer per tab: a second listener of the same Agent joins the stream where it is.
      existing.listeners.add(listener);
    } else {
      const subscription: Subscription = { after, listeners: new Set([listener]) };
      this._subscriptions.set(agentId, subscription);
      this._send({ type: "subscribe", agentId, after });
    }
    return () => {
      const subscription = this._subscriptions.get(agentId);
      if (!subscription) return;
      subscription.listeners.delete(listener);
      if (subscription.listeners.size > 0) return;
      this._subscriptions.delete(agentId);
      this._send({ type: "unsubscribe", agentId });
    };
  }

  private _send(message: ClientMessage): void {
    if (!this._socket || this._socket.readyState !== OPEN) return;
    this._socket.send(JSON.stringify(message));
  }
}

export const liveFeeds = new LiveFeeds();
