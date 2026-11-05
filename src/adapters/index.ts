import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { GitHubPort, Ports, WorktreePort } from "../ports/index.js";
import { agentEnvSourceFrom } from "./agent-env.js";
import { SystemClock } from "./clock.js";
import { SdkDriver } from "./driver.js";
import { notImplemented } from "./not-implemented.js";
import { NodeProcessPort } from "./process.js";

export { SystemClock } from "./clock.js";
export { NodeProcessPort } from "./process.js";
export { SdkDriver, RootUserError, ClaudeNotFoundError, ProcessNotRunningError, findClaudeExecutable } from "./driver.js";
export type { SdkDriverOptions } from "./driver.js";
export { buildAgentEnv, agentEnvSourceFrom, AGENT_ENV_KEYS, AgentEnvError } from "./agent-env.js";
export type { AgentEnvSource } from "./agent-env.js";
export { ASK_HUMAN_TOOL_NAME, ASK_HUMAN_SERVER, ASK_HUMAN_TOOL } from "./ask-human.js";
export { notImplemented, NotImplementedError } from "./not-implemented.js";

// The ask_human server next to this module: compiled JS under dist/, the TypeScript source under tsx in dev mode.
export function askHumanServerArgs(): string[] {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  if (here.endsWith(".ts")) {
    const tsx = path.resolve(dir, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    return [tsx, path.join(dir, "ask-human-mcp.ts")];
  }
  return [path.join(dir, "ask-human-mcp.js")];
}

export type SystemPortsDeps = {
  config: Config;
  log: Logger;
  processes?: NodeProcessPort;
};

// Real adapters of the Installation. GitHub and worktree adapters are added by their own tickets.
export function createSystemPorts(deps: SystemPortsDeps): Ports {
  const processes = deps.processes ?? new NodeProcessPort();
  const driver = new SdkDriver({
    envSource: agentEnvSourceFrom(deps.config.values, { claudeConfigDir: deps.config.claudeConfigDir }),
    claudePath: deps.config.claudePath,
    askHumanServerArgs: askHumanServerArgs(),
    isRoot: () => processes.isRoot(),
    log: deps.log,
  });
  return {
    github: notImplemented<GitHubPort>("GitHubPort"),
    driver,
    worktree: notImplemented<WorktreePort>("WorktreePort"),
    clock: new SystemClock(),
    processes,
  };
}
