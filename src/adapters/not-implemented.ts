export class NotImplementedError extends Error {
  constructor(port: string, method: string) {
    super(`${port}.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

// Placeholder for ports whose real adapters arrive in later tickets: every call throws.
export function notImplemented<T extends object>(port: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return () => {
        throw new NotImplementedError(port, property);
      };
    },
  });
}
