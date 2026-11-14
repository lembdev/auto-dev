import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const script = path.join(repoRoot, "scripts", "next-version.sh");

describe("scripts/next-version.sh", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // A throwaway repository; each message becomes an empty commit, a tag lands on the latest commit.
  const repo = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-next-version-"));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    return {
      commit: (...messages: string[]) => {
        for (const message of messages) git("commit", "-q", "--allow-empty", "-m", message);
      },
      tag: (name: string) => git("tag", name),
      next: (...args: string[]) => execFileSync("bash", [script, ...args], { cwd: dir, encoding: "utf8" }).trim(),
    };
  };

  it("bumps patch for fix and perf", () => {
    const r = repo();
    r.commit("feat: initial");
    r.tag("v1.2.3");
    r.commit("fix: handle empty input", "perf: cache the lookup", "docs: explain");
    expect(r.next()).toBe("1.2.4");
  });

  it("bumps minor for feat and resets patch", () => {
    const r = repo();
    r.commit("feat: initial");
    r.tag("v1.2.3");
    r.commit("fix: one", "feat: two");
    expect(r.next()).toBe("1.3.0");
  });

  it("bumps major for `type!:` and for a BREAKING CHANGE footer", () => {
    const bang = repo();
    bang.commit("feat: initial");
    bang.tag("v1.2.3");
    bang.commit("feat!: drop the old api");
    expect(bang.next()).toBe("2.0.0");

    const footer = repo();
    footer.commit("feat: initial");
    footer.tag("v1.2.3");
    footer.commit("refactor: rework\n\nBREAKING CHANGE: config moved");
    expect(footer.next()).toBe("2.0.0");
  });

  it("prints nothing when no commit calls for a release", () => {
    const r = repo();
    r.commit("feat: initial");
    r.tag("v1.0.0");
    r.commit("chore: release 1.0.0", "docs: readme", "test: more", "not conventional at all");
    expect(r.next()).toBe("");
    expect(r.next("--notes")).toBe("");
  });

  it("counts from the last release tag and ignores pre-release tags", () => {
    const r = repo();
    r.commit("feat: initial");
    r.tag("v1.0.0");
    r.commit("feat: next");
    r.tag("v1.1.0-rc1");
    r.commit("fix: after rc");
    expect(r.next()).toBe("1.1.0");
  });

  it("starts from 0.0.0 without any release tag", () => {
    const r = repo();
    r.commit("chore: scaffold", "fix: first");
    expect(r.next()).toBe("0.0.1");
  });

  it("writes release notes grouped by kind", () => {
    const r = repo();
    r.commit("feat: initial");
    r.tag("v1.0.0");
    r.commit("fix: crash on start", "feat: dark mode", "chore: tidy", "feat!: new config");
    const notes = r.next("--notes");
    expect(notes).toMatch(/^### Breaking changes\n\n- new config \([0-9a-f]+\)\n\n### Features\n\n- dark mode \([0-9a-f]+\)\n\n### Fixes\n\n- crash on start \([0-9a-f]+\)$/);
  });
});
