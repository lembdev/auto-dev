export type * from "./github.js";
export { GitHubError, GitHubNotFoundError } from "./github.js";
export type * from "./driver.js";
export type * from "./worktree.js";
export type * from "./clock.js";
export type * from "./process.js";

import type { Clock } from "./clock.js";
import type { DriverPort } from "./driver.js";
import type { GitHubPort } from "./github.js";
import type { ProcessPort } from "./process.js";
import type { WorktreePort } from "./worktree.js";

// The only seam of the Orchestrator: everything outside the process comes through these.
export type Ports = {
  github: GitHubPort;
  driver: DriverPort;
  worktree: WorktreePort;
  clock: Clock;
  processes: ProcessPort;
};
