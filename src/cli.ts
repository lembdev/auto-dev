import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import { migrations } from "./index/migrations.js";
import { openRuntimeIndex, SchemaVersionError } from "./index/runtime-index.js";
import { TURN_WAIT_TIMEOUT_MS, type UpdatePhase } from "./orchestrator/update-coordinator.js";

// Commands the updater runs next to the service: `node dist/main.js <command>`.
export const CLI_COMMANDS = ["migrate", "schema-version", "prepare-update"] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

export const isCliCommand = (value: string | undefined): value is CliCommand => CLI_COMMANDS.includes(value as CliCommand);

// Exit codes the update script tells apart.
export const EXIT = {
  ok: 0,
  failed: 1,
  // The service does not answer: there is nothing to prepare, the update goes on without it.
  unreachable: 2,
  // The runtime index is newer than this release; a downgrade is not possible.
  schemaTooNew: 3,
} as const;

// The token the updater presents to the service on the same host; a new one is written on every start.
export const UPDATE_TOKEN_FILE = "update.token";
export const updateTokenPath = (dataDir: string): string => path.join(dataDir, UPDATE_TOKEN_FILE);

// Readable by the service user and root only; replaced atomically so a reader never sees half a token.
export function writeUpdateToken(dataDir: string): string {
  const token = randomBytes(32).toString("hex");
  const target = updateTokenPath(dataDir);
  const temp = `${target}.${process.pid}`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
  return token;
}

// The preparation waits for the Turns up to ten minutes; the margin covers the interrupts and the polling.
export const PREPARE_TIMEOUT_MS = TURN_WAIT_TIMEOUT_MS + 2 * 60_000;
export const PREPARE_POLL_MS = 2_000;

export type CliDeps = {
  config: Config;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readFile?: (filePath: string) => string;
};

// The latest schema version this code knows; the one the index reaches after `migrate`.
export const codeSchemaVersion = (): number => Math.max(0, ...migrations.map((migration) => migration.version));

// Version of the index on disk without touching it; 0 when there is no index yet.
export const dbSchemaVersion = (dbPath: string): number => {
  if (!existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    if (!table) return 0;
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null };
    return row.version ?? 0;
  } finally {
    db.close();
  }
};

export async function runCli(command: CliCommand, args: readonly string[], deps: CliDeps): Promise<number> {
  switch (command) {
    case "migrate":
      return migrate(deps);
    case "schema-version":
      deps.out(String(args.includes("--db") ? dbSchemaVersion(deps.config.runtimeDbPath) : codeSchemaVersion()));
      return EXIT.ok;
    case "prepare-update":
      return prepareUpdate(deps);
  }
}

function migrate(deps: CliDeps): number {
  try {
    const index = openRuntimeIndex(deps.config.runtimeDbPath);
    deps.out(`runtime index at schema version ${index.schemaVersion()}`);
    index.close();
    return EXIT.ok;
  } catch (error) {
    if (error instanceof SchemaVersionError) {
      deps.err(error.message);
      return EXIT.schemaTooNew;
    }
    throw error;
  }
}

// The address the service listens on, as seen from the same host.
const localBaseUrl = (config: Config): string => {
  const wildcard = config.host === "" || config.host === "0.0.0.0" || config.host === "::";
  const host = wildcard ? "127.0.0.1" : config.host.includes(":") ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}`;
};

type InstallationUpdate = { update?: { phase?: UpdatePhase } };

// Asks the running service to get ready for a stop and waits until it is: Pause, the Turns finished or interrupted.
async function prepareUpdate(deps: CliDeps): Promise<number> {
  const fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));

  let token: string;
  try {
    token = readFile(updateTokenPath(deps.config.dataDir)).trim();
  } catch {
    deps.err("no update token: the service has not started on this release");
    return EXIT.unreachable;
  }
  const base = localBaseUrl(deps.config);
  const headers = { authorization: `Bearer ${token}` };

  try {
    const started = await fetchFn(`${base}/api/installation/prepare-update`, { method: "POST", headers });
    if (started.status !== 202) {
      deps.err(`the service refused the preparation with ${started.status}`);
      return EXIT.failed;
    }
  } catch (error) {
    deps.err(`the service does not answer: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.unreachable;
  }
  deps.out("pause set, waiting for the running turns");

  const deadline = now() + PREPARE_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetchFn(`${base}/api/installation`, { headers });
      if (response.ok && ((await response.json()) as InstallationUpdate).update?.phase === "ready") {
        deps.out("ready for the update");
        return EXIT.ok;
      }
    } catch (error) {
      deps.err(`the service stopped answering: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT.unreachable;
    }
    if (now() >= deadline) {
      deps.err("the service did not get ready in time");
      return EXIT.failed;
    }
    await sleep(PREPARE_POLL_MS);
  }
}
