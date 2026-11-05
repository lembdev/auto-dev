import type { DriverPort, GitHubPort, Ports, WorktreePort } from "../ports/index.js";
import { SystemClock } from "./clock.js";
import { notImplemented } from "./not-implemented.js";
import { NodeProcessPort } from "./process.js";

export { SystemClock } from "./clock.js";
export { NodeProcessPort } from "./process.js";
export { notImplemented, NotImplementedError } from "./not-implemented.js";

// Real adapters of the Installation. GitHub, Driver and worktree adapters are added by their own tickets.
export function createSystemPorts(): Ports {
  return {
    github: notImplemented<GitHubPort>("GitHubPort"),
    driver: notImplemented<DriverPort>("DriverPort"),
    worktree: notImplemented<WorktreePort>("WorktreePort"),
    clock: new SystemClock(),
    processes: new NodeProcessPort(),
  };
}
