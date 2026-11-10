import type { Hono } from "hono";
import { Settings, SettingsError, type SettingsPatch } from "../setup/settings.js";
import type { ModelsResponse, SettingsResponse } from "./api-types.js";

export type SettingsRouteDeps = {
  settings: Settings;
};

const FIELDS: (keyof SettingsPatch)[] = ["maxParallelTasks", "prearmEnabled", "maxQaRounds", "model", "githubToken", "oauthToken", "password"];

// Keeps only the known fields; the service validates their values.
const parsePatch = (body: unknown): SettingsPatch | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const field of FIELDS) {
    if (raw[field] !== undefined) patch[field] = raw[field];
  }
  return patch as SettingsPatch;
};

export function registerSettingsRoutes(app: Hono, deps: SettingsRouteDeps): void {
  app.get("/api/settings", (c) => {
    const body: SettingsResponse = deps.settings.view();
    return c.json(body);
  });

  app.get("/api/settings/models", async (c) => {
    const body: ModelsResponse = await deps.settings.models();
    return c.json(body);
  });

  app.put("/api/settings", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body must be a JSON object" }, 400);
    }
    const patch = parsePatch(raw);
    if (!patch) return c.json({ error: "body must be a JSON object" }, 400);
    try {
      const body: SettingsResponse = await deps.settings.update(patch);
      return c.json(body);
    } catch (error) {
      if (error instanceof SettingsError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
}
