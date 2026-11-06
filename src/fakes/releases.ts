import type { Release, ReleasesPort } from "../ports/releases.js";
import { CallLog } from "./call-log.js";

export class FakeReleasesPort implements ReleasesPort {
  readonly log = new CallLog();
  // What the next check sees; undefined stands for "nothing published yet".
  latest: Release | undefined;
  // Set to make the next check fail the way an unreachable GitHub does.
  failure: Error | undefined;

  get calls() {
    return this.log.calls;
  }

  publish(version: string, overrides: Partial<Omit<Release, "version">> = {}): Release {
    this.latest = {
      version,
      htmlUrl: overrides.htmlUrl ?? `https://github.com/lembdev/auto-dev/releases/tag/v${version}`,
      publishedAt: overrides.publishedAt ?? null,
    };
    return this.latest;
  }

  async findLatest(): Promise<Release | undefined> {
    this.log.record("findLatest");
    if (this.failure) throw this.failure;
    return this.latest ? { ...this.latest } : undefined;
  }
}
