export class PortNotConfiguredError extends Error {
  constructor(port: string, method: string) {
    super(`${port}.${method}: the port is not configured yet; finish the first-run wizard`);
    this.name = "PortNotConfiguredError";
  }
}

export type SwitchablePort<T extends object> = {
  // The stable object everybody holds; calls go to the current target.
  port: T;
  use(target: T | undefined): void;
  target(): T | undefined;
};

// A port whose real adapter can be replaced while the Installation runs: the wizard stores a
// token, the GitHub adapter is rebuilt, and every holder of `port` talks to the new one.
export function createSwitchablePort<T extends object>(name: string): SwitchablePort<T> {
  let current: T | undefined;
  const port = new Proxy({} as T, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return (...args: unknown[]) => {
        if (current === undefined) throw new PortNotConfiguredError(name, property);
        const method = (current as Record<string, unknown>)[property];
        if (typeof method !== "function") throw new TypeError(`${name}.${property} is not a function`);
        return (method as (...callArgs: unknown[]) => unknown).apply(current, args);
      };
    },
  });
  return {
    port,
    use: (target) => {
      current = target;
    },
    target: () => current,
  };
}
