export type Listener<T> = (value: T) => void;

// Fan-out of index changes to in-process subscribers (the WebSocket feed of the UI). A listener that
// throws does not stop the write that triggered it; the error is left to the caller's logger.
export class Listeners<T> {
  private readonly _listeners = new Set<Listener<T>>();

  add(listener: Listener<T>): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of this._listeners) listener(value);
  }
}
