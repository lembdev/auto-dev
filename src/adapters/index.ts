import type { GitHubConfig } from "../config.js";
import type { DriverPort, GitHubPort, Ports, WorktreePort } from "../ports/index.js";
import { SystemClock } from "./clock.js";
import { GitHubRestAdapter } from "./github.js";
import { notImplemented } from "./not-implemented.js";
import { NodeProcessPort } from "./process.js";

export { SystemClock } from "./clock.js";
export { GitHubRestAdapter, GITHUB_API_VERSION, type GitHubRestOptions } from "./github.js";
export { NodeProcessPort } from "./process.js";
export { notImplemented, NotImplementedError } from "./not-implemented.js";

export type SystemPortsOptions = {
  github?: GitHubConfig;
  version: string;
};

// Real adapters of the Installation. Driver and worktree adapters are added by their own tickets;
// GitHub stays a placeholder until the first-run wizard has stored a token and a repository.
export function createSystemPorts(options: SystemPortsOptions): Ports {
  const clock = new SystemClock();
  return {
    github: options.github
      ? new GitHubRestAdapter({ ...options.github, clock, userAgent: `auto-dev/${options.version}` })
      : notImplemented<GitHubPort>("GitHubPort"),
    driver: notImplemented<DriverPort>("DriverPort"),
    worktree: notImplemented<WorktreePort>("WorktreePort"),
    clock,
    processes: new NodeProcessPort(),
  };
}
