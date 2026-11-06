import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigStore } from "../config-store.js";
import type { Config, GitHubConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { GitHubPort, Ports } from "../ports/index.js";
import { agentEnvSourceFrom } from "./agent-env.js";
import { SystemClock } from "./clock.js";
import { NodeDiskPort } from "./disk.js";
import { SdkDriver } from "./driver.js";
import { GitHubRestAdapter } from "./github.js";
import { createSwitchablePort } from "./switchable.js";
import { NodeProcessPort } from "./process.js";
import { GitHubReleasesAdapter } from "./releases.js";
import { statusLineSettings } from "./statusline.js";
import { GitWorktreeAdapter } from "./worktree.js";

export { SystemClock } from "./clock.js";
export { GitHubRestAdapter, GITHUB_API_VERSION, type GitHubRestOptions } from "./github.js";
export { NodeProcessPort } from "./process.js";
export { NodeDiskPort } from "./disk.js";
export { GitHubReleasesAdapter, ReleasesError, RELEASES_REPO, versionOfTag, type GitHubReleasesOptions } from "./releases.js";
export { statusLineSettings, statusLineWriterArgs, type StatusLineOptions } from "./statusline.js";
export { SdkDriver, RootUserError, ClaudeNotFoundError, ProcessNotRunningError, findClaudeExecutable } from "./driver.js";
export type { SdkDriverOptions } from "./driver.js";
export { buildAgentEnv, agentEnvSourceFrom, AGENT_ENV_KEYS, AgentEnvError } from "./agent-env.js";
export type { AgentEnvSource } from "./agent-env.js";
export { ASK_HUMAN_TOOL_NAME, ASK_HUMAN_SERVER, ASK_HUMAN_TOOL } from "./ask-human.js";
export { createSwitchablePort, PortNotConfiguredError, type SwitchablePort } from "./switchable.js";
export { GitWorktreeAdapter, GitError, parseWorktreeList, type GitWorktreeOptions } from "./worktree.js";

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

export type SystemPortsOptions = {
  config: ConfigStore;
  log: Logger;
  version: string;
  processes?: NodeProcessPort;
};

export type SystemPorts = Ports & {
  // A GitHub adapter for a token and repository that are not stored yet: the wizard checks access with it.
  githubFor(github: GitHubConfig): GitHubPort;
};

// Real adapters of the Installation. They read the live configuration: the GitHub adapter is rebuilt
// when the token or the repository changes, the Driver picks the Agent environment up per launch.
export function createSystemPorts(options: SystemPortsOptions): SystemPorts {
  const clock = new SystemClock();
  const processes = options.processes ?? new NodeProcessPort();
  const current = (): Config => options.config.current();
  const githubFor = (github: GitHubConfig): GitHubPort =>
    new GitHubRestAdapter({ ...github, clock, userAgent: `auto-dev/${options.version}` });
  const driver = new SdkDriver({
    envSource: () => agentEnvSourceFrom(current().values, { claudeConfigDir: current().claudeConfigDir }),
    claudePath: current().claudePath,
    askHumanServerArgs: askHumanServerArgs(),
    isRoot: () => processes.isRoot(),
    settings: statusLineSettings({ dataDir: current().dataDir }),
    log: options.log,
  });
  const github = createSwitchablePort<GitHubPort>("GitHubPort");
  const applyGitHub = (config: Config, previous?: Config) => {
    if (previous && sameGitHub(config.github, previous.github)) return;
    github.use(config.github ? githubFor(config.github) : undefined);
  };
  applyGitHub(current());
  options.config.onChange(applyGitHub);
  return {
    github: github.port,
    driver,
    worktree: new GitWorktreeAdapter({ token: () => current().github?.token }),
    clock,
    processes,
    disk: new NodeDiskPort(),
    releases: new GitHubReleasesAdapter({ userAgent: `auto-dev/${options.version}` }),
    githubFor,
  };
}

const sameGitHub = (a: GitHubConfig | undefined, b: GitHubConfig | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.token === b.token && a.owner === b.owner && a.repo === b.repo);
