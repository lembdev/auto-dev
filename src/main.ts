import { mkdirSync } from "node:fs";
import { createSystemPorts } from "./adapters/index.js";
import { ConfigError, loadConfig } from "./config.js";
import { openRuntimeIndex } from "./index/runtime-index.js";
import { createLogger } from "./log.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createApp } from "./server/app.js";
import { startServer } from "./server/server.js";
import { VERSION } from "./version.js";

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

  const log = createLogger({ level: config.logLevel });
  log.info({ version: VERSION, envFile: config.envFile, envFileExists: config.envFileExists, dataDir: config.dataDir }, "starting");

  mkdirSync(config.dataDir, { recursive: true });
  const index = openRuntimeIndex(config.runtimeDbPath);
  log.info({ path: config.runtimeDbPath, schemaVersion: index.schemaVersion() }, "runtime index ready");

  const ports = createSystemPorts(config.github ? { github: config.github, version: VERSION } : { version: VERSION });
  const orchestrator = new Orchestrator({ ports, index, log });
  const app = createApp({ ports, index, log, version: VERSION, orchestrator });
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
    orchestrator.stop();
    server
      .close()
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
