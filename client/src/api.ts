export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// One fetch wrapper for the JSON API: same-origin cookies, JSON bodies, errors with the status.
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...rest, headers, credentials: "same-origin", ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Not JSON: the status text is all there is.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}
