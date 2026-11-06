import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSystemPorts } from "./adapters/index.js";
import { createJournalLogSource, runsUnderJournald, SYSTEMD_UNIT } from "./adapters/journal.js";
import { ConfigStore } from "./config-store.js";
import { ConfigError } from "./config.js";
import { openRuntimeIndex } from "./index/runtime-index.js";
import { createLogger, LogBuffer } from "./log.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createApp } from "./server/app.js";
import { startServer } from "./server/server.js";
import { Settings } from "./setup/settings.js";
import { Setup } from "./setup/setup.js";
import { VERSION } from "./version.js";

// The client bundle is built next to the server bundle: `dist/client` beside `dist/main.js`.
const CLIENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "client");

async function main(): Promise<void> {
  let configStore: ConfigStore;
  try {
    configStore = new ConfigStore();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`auto-dev: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const config = configStore.current();

  const logBuffer = new LogBuffer();
  const log = createLogger({ level: config.logLevel, buffer: logBuffer });
  const logs = runsUnderJournald() ? createJournalLogSource({ unit: SYSTEMD_UNIT, fallback: logBuffer }) : logBuffer;
  log.info({ version: VERSION, envFile: config.envFile, envFileExists: config.envFileExists, dataDir: config.dataDir }, "starting");
  // The SDK's session helpers look up transcripts under the config dir of this process.
  process.env.CLAUDE_CONFIG_DIR ??= config.claudeConfigDir;

  mkdirSync(config.dataDir, { recursive: true });
  const index = openRuntimeIndex(config.runtimeDbPath);
  log.info({ path: config.runtimeDbPath, schemaVersion: index.schemaVersion() }, "runtime index ready");

  const ports = createSystemPorts({ config: configStore, log, version: VERSION });
  const orchestrator = new Orchestrator({ ports, index, log, product: { repoPath: config.repoPath }, dataDir: config.dataDir });
  const setup = new Setup({
    config: configStore,
    installation: index.installation,
    worktree: ports.worktree,
    driver: ports.driver,
    github: ports.githubFor,
    log,
  });
  const settings = new Settings({
    config: configStore,
    installation: index.installation,
    state: orchestrator.installation,
    runner: orchestrator.agents,
    qa: orchestrator.qa,
    maxParallelTasks: () => orchestrator.maxParallelTasks(),
    setup,
    log,
  });
  const app = createApp({
    ports,
    index,
    log,
    version: VERSION,
    orchestrator,
    config: configStore,
    setup,
    settings,
    auth: { allowedHosts: config.allowedHosts },
    clientDir: CLIENT_DIR,
    logs,
  });
  const server = await startServer({ app, host: config.host, port: config.port, log });

  // The Orchestrator polls only once the wizard is through; finishing it starts the polling at once.
  const startOrchestrator = () => {
    const github = configStore.current().github;
    log.info({ repo: github ? `${github.owner}/${github.repo}` : null }, "orchestrator starting");
    void orchestrator.start();
  };
  if (await setup.isComplete()) {
    startOrchestrator();
  } else {
    log.warn({ step: (await setup.status()).current }, "first-run setup is not finished; open the UI to continue it");
    setup.onComplete(startOrchestrator);
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
