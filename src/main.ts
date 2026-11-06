import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSystemPorts } from "./adapters/index.js";
import { createJournalLogSource, runsUnderJournald, SYSTEMD_UNIT } from "./adapters/journal.js";
import { cloneUrlOf, ConfigError, loadConfig } from "./config.js";
import { openRuntimeIndex } from "./index/runtime-index.js";
import { createLogger, LogBuffer } from "./log.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createApp } from "./server/app.js";
import { startServer } from "./server/server.js";
import { VERSION } from "./version.js";

// The client bundle is built next to the server bundle: `dist/client` beside `dist/main.js`.
const CLIENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "client");

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`auto-dev: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const logBuffer = new LogBuffer();
  const log = createLogger({ level: config.logLevel, buffer: logBuffer });
  const logs = runsUnderJournald() ? createJournalLogSource({ unit: SYSTEMD_UNIT, fallback: logBuffer }) : logBuffer;
  log.info({ version: VERSION, envFile: config.envFile, envFileExists: config.envFileExists, dataDir: config.dataDir }, "starting");
  // The SDK's session helpers look up transcripts under the config dir of this process.
  process.env.CLAUDE_CONFIG_DIR ??= config.claudeConfigDir;

  mkdirSync(config.dataDir, { recursive: true });
  const index = openRuntimeIndex(config.runtimeDbPath);
  log.info({ path: config.runtimeDbPath, schemaVersion: index.schemaVersion() }, "runtime index ready");

  const ports = createSystemPorts({ config, log, version: VERSION });
  const clone = config.github ? { repoPath: config.repoPath, cloneUrl: cloneUrlOf(config.github) } : { repoPath: config.repoPath };
  const orchestrator = new Orchestrator({ ports, index, log, product: clone, dataDir: config.dataDir });
  const product = config.github
    ? { fullName: `${config.github.owner}/${config.github.repo}`, htmlUrl: `https://github.com/${config.github.owner}/${config.github.repo}` }
    : undefined;
  if (config.passwordHash === undefined) log.warn("AUTO_DEV_PASSWORD_HASH is not set; nobody can log in to the UI");
  const app = createApp({
    ports,
    index,
    log,
    version: VERSION,
    orchestrator,
    auth: { passwordHash: config.passwordHash, allowedHosts: config.allowedHosts },
    clientDir: CLIENT_DIR,
    logs,
    ...(product ? { product } : {}),
  });
  const server = await startServer({ app, host: config.host, port: config.port, log });

  if (config.github) {
    log.info({ repo: `${config.github.owner}/${config.github.repo}` }, "orchestrator starting");
    void orchestrator.start();
  } else {
    log.warn("GITHUB_TOKEN and GITHUB_REPO are not set; the orchestrator stays idle");
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    orchestrator
      .shutdown()
      .catch((error: unknown) => log.error({ err: error }, "agent shutdown failed"))
      .then(() => server.close())
      .catch((error: unknown) => log.error({ err: error }, "server close failed"))
      .finally(() => {
        index.close();
        process.exit(0);
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`auto-dev: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
