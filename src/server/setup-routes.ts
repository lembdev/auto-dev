import type { Context, Hono } from "hono";
import type { Logger } from "../log.js";
import { Setup, SetupError } from "../setup/setup.js";
import type { SetupAccessResponse, SetupOauthRequest, SetupPasswordRequest, SetupRepositoryRequest, SetupSmokeResponse, SetupStatus } from "./api-types.js";
import { hasSession, setSessionCookie, type SessionCookies } from "./auth.js";

export type SetupRouteDeps = {
  setup: Setup;
  sessions: SessionCookies;
  passwordHash: () => string | undefined;
  log: Logger;
};

export const SETUP_PATH = "/api/setup";

// The wizard works without a session only until a password exists; after that its steps are
// behind the login like everything else, and the status alone stays public for the UI to decide.
export const isPublicSetupRequest = (c: Context, passwordHash: () => string | undefined): boolean => {
  if (c.req.path === SETUP_PATH && c.req.method === "GET") return true;
  return c.req.path.startsWith(`${SETUP_PATH}/`) && passwordHash() === undefined;
};

const readJson = async (c: Context): Promise<Record<string, unknown> | undefined> => {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const stringField = (body: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = body?.[key];
  return typeof value === "string" ? value : undefined;
};

export function registerSetupRoutes(app: Hono, deps: SetupRouteDeps): void {
  // Before the login the status names no repository: that much stays private.
  const statusFor = async (c: Context, status?: SetupStatus): Promise<SetupStatus> => {
    const current = status ?? (await deps.setup.status());
    return hasSession(c, deps.sessions) ? current : { ...current, repo: null, repoPath: "" };
  };

  const step = async (c: Context, run: () => Promise<SetupStatus>) => {
    try {
      return c.json(await statusFor(c, await run()));
    } catch (error) {
      if (error instanceof SetupError) return c.json({ error: error.message }, 400);
      throw error;
    }
  };

  app.get(SETUP_PATH, async (c) => c.json(await statusFor(c)));

  app.post(`${SETUP_PATH}/password`, async (c) => {
    const body = await readJson(c);
    const password = stringField(body, "password" satisfies keyof SetupPasswordRequest);
    if (password === undefined) return c.json({ error: "body must be JSON with a string `password`" }, 400);
    let status: SetupStatus;
    try {
      status = await deps.setup.setPassword(password);
    } catch (error) {
      if (error instanceof SetupError) return c.json({ error: error.message }, 400);
      throw error;
    }
    // The human who just chose the password is logged in with it.
    setSessionCookie(c, deps.sessions.issue().value);
    return c.json(status);
  });

  app.post(`${SETUP_PATH}/repository`, async (c) => {
    const body = await readJson(c);
    const repo = stringField(body, "repo" satisfies keyof SetupRepositoryRequest);
    const token = stringField(body, "token" satisfies keyof SetupRepositoryRequest);
    if (repo === undefined || token === undefined) return c.json({ error: "body must be JSON with strings `repo` and `token`" }, 400);
    return step(c, () => deps.setup.setRepository({ repo, token }));
  });

  app.post(`${SETUP_PATH}/access`, async (c) => {
    try {
      const check = await deps.setup.checkAccess();
      const body: SetupAccessResponse = { ...check, status: await statusFor(c) };
      return c.json(body);
    } catch (error) {
      if (error instanceof SetupError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.post(`${SETUP_PATH}/oauth`, async (c) => {
    const body = await readJson(c);
    const token = stringField(body, "token" satisfies keyof SetupOauthRequest);
    if (token === undefined) return c.json({ error: "body must be JSON with a string `token`" }, 400);
    return step(c, () => deps.setup.setOauthToken(token));
  });

  app.post(`${SETUP_PATH}/smoke`, async (c) => {
    try {
      const check = await deps.setup.smokeQuery();
      const body: SetupSmokeResponse = { ...check, status: await statusFor(c) };
      return c.json(body);
    } catch (error) {
      if (error instanceof SetupError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.post(`${SETUP_PATH}/clone`, async (c) => {
    try {
      return c.json(await statusFor(c, await deps.setup.clone()));
    } catch (error) {
      if (error instanceof SetupError) return c.json({ error: error.message }, 400);
      deps.log.error({ err: error }, "clone failed");
      return c.json({ error: `clone failed: ${error instanceof Error ? error.message : String(error)}` }, 502);
    }
  });
}
