export { CallLog, type Call } from "./call-log.js";
export { FakeClock } from "./clock.js";
export { FakeDiskPort } from "./disk.js";
export { FakeDriverPort, FakeAgentProcess } from "./driver.js";
export { FakeGitHubPort } from "./github.js";
export type { IssueSeed, MilestoneSeed, PullRequestSeed, CheckRunSeed, CommitStatusSeed, Reaction } from "./github.js";
export { FakeProcessPort, type FakeProcessSpec, type SignalRecord, type SpawnRecord } from "./process.js";
export { FakeReleasesPort } from "./releases.js";
export { FakeWorktreePort } from "./worktree.js";
export { sdkMessages } from "./sdk-messages.js";

import type { Ports } from "../ports/index.js";
import { FakeClock } from "./clock.js";
import { FakeDiskPort } from "./disk.js";
import { FakeDriverPort } from "./driver.js";
import { FakeGitHubPort } from "./github.js";
import { FakeProcessPort } from "./process.js";
import { FakeReleasesPort } from "./releases.js";
import { FakeWorktreePort } from "./worktree.js";

export type FakePorts = Ports & {
  github: FakeGitHubPort;
  driver: FakeDriverPort;
  worktree: FakeWorktreePort;
  clock: FakeClock;
  processes: FakeProcessPort;
  disk: FakeDiskPort;
  releases: FakeReleasesPort;
};

// One set of fakes sharing a clock, ready to be handed to the Orchestrator and the server.
export function createFakePorts(): FakePorts {
  const clock = new FakeClock();
  const github = new FakeGitHubPort({ now: () => clock.now() });
  const worktree = new FakeWorktreePort();
  worktree.onPush = (branch, commitsAhead) => github.recordPush(branch, commitsAhead);
  return {
    github,
    driver: new FakeDriverPort(),
    worktree,
    clock,
    processes: new FakeProcessPort(),
    disk: new FakeDiskPort(),
    releases: new FakeReleasesPort(),
  };
}
