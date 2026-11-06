export type * from "./github.js";
export { GitHubError, GitHubNotFoundError, REPOSITORY_PERMISSIONS, missingPermissions } from "./github.js";
export type * from "./driver.js";
export type * from "./worktree.js";
export type * from "./clock.js";
export type * from "./process.js";
export type * from "./disk.js";
export type * from "./releases.js";

import type { Clock } from "./clock.js";
import type { DiskPort } from "./disk.js";
import type { DriverPort } from "./driver.js";
import type { GitHubPort } from "./github.js";
import type { ProcessPort } from "./process.js";
import type { ReleasesPort } from "./releases.js";
import type { WorktreePort } from "./worktree.js";

// The only seam of the Orchestrator: everything outside the process comes through these.
export type Ports = {
  github: GitHubPort;
  driver: DriverPort;
  worktree: WorktreePort;
  clock: Clock;
  processes: ProcessPort;
  disk: DiskPort;
  releases: ReleasesPort;
};
