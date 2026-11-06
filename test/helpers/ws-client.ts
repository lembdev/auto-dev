import { WebSocket } from "ws";

// WebSocket client that queues every message from the moment of connection, so nothing is lost
// between the handshake and the first `await`.
export class WsClient {
  private readonly _queue: unknown[] = [];
  private readonly _waiters: ((message: unknown) => void)[] = [];

  private constructor(private readonly _socket: WebSocket) {
    _socket.on("message", (data) => {
      const message: unknown = JSON.parse(data.toString());
      const waiter = this._waiters.shift();
      if (waiter) waiter(message);
      else this._queue.push(message);
    });
  }

  // `headers` carries the session cookie and the `Origin` a browser would send.
  static connect(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      const client = new WsClient(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
    });
  }

  next(timeoutMs = 5_000): Promise<unknown> {
    const queued = this._queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no WebSocket message within the timeout")), timeoutMs);
      this._waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  send(message: unknown): void {
    this._socket.send(JSON.stringify(message));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this._socket.once("close", () => resolve());
      this._socket.close();
    });
  }
}
