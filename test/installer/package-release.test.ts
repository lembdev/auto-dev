import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const script = path.join(repoRoot, "scripts", "package-release.sh");

const write = (root: string, relative: string, content: string) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
};

// A built checkout in miniature: everything the archive must carry, plus sources that must stay out.
const fakeBuiltRoot = (dir: string, version = "1.2.3"): string => {
  const root = path.join(dir, "root");
  write(root, "package.json", JSON.stringify({ name: "auto-dev", version, private: true, type: "module", main: "dist/main.js", dependencies: {} }));
  write(root, "package-lock.json", JSON.stringify({ name: "auto-dev", version, lockfileVersion: 3, requires: true, packages: { "": { name: "auto-dev", version } } }));
  write(root, "dist/main.js", "console.log('hi')\n");
  write(root, "dist/client/index.html", "<!doctype html>\n");
  write(root, "prompts/common.md", "# common\n");
  write(root, "deploy/auto-dev.service", "[Service]\n");
  write(root, "deploy/auto-dev.sudoers", "# none\n");
  write(root, "README.md", "# auto-dev\n");
  write(root, "src/main.ts", "export {}\n");
  write(root, "test/x.test.ts", "export {}\n");
  return root;
};

const listArchive = (archive: string): string[] =>
  execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/\/$/, ""));

describe("scripts/package-release.sh", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-package-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Stands in for npm: records the call and plants one "installed" package, so the test needs no registry.
  const npmShim = (dir: string): { path: string; log: string } => {
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "npm.log");
    write(bin, "npm", `#!/usr/bin/env bash\necho "$PWD $*" >> "${log}"\nmkdir -p node_modules/fake-dep && echo 'module.exports = 1' > node_modules/fake-dep/index.js\n`);
    chmodSync(path.join(bin, "npm"), 0o755);
    return { path: `${bin}:${process.env.PATH ?? ""}`, log };
  };

  it("packs dist, prompts, deploy, the manifests and production node_modules under auto-dev-<version>/", () => {
    const dir = tempDir();
    const root = fakeBuiltRoot(dir);
    const out = path.join(dir, "out");
    const npm = npmShim(dir);

    const stdout = execFileSync("bash", [script, "--root", root, "--out", out], { encoding: "utf8", env: { ...process.env, PATH: npm.path } });
    const npmCalls = readFileSync(npm.log, "utf8").trim().split("\n");
    expect(npmCalls).toHaveLength(1);
    expect(npmCalls[0]).toMatch(/\/auto-dev-1\.2\.3 ci --omit=dev --omit=optional/);
    const archive = path.join(out, "auto-dev-1.2.3.tar.gz");
    expect(stdout.trim().split("\n").at(-1)).toBe(archive);
    expect(existsSync(archive)).toBe(true);

    const entries = listArchive(archive);
    for (const expected of [
      "auto-dev-1.2.3/dist/main.js",
      "auto-dev-1.2.3/dist/client/index.html",
      "auto-dev-1.2.3/prompts/common.md",
      "auto-dev-1.2.3/deploy/auto-dev.service",
      "auto-dev-1.2.3/deploy/auto-dev.sudoers",
      "auto-dev-1.2.3/package.json",
      "auto-dev-1.2.3/package-lock.json",
      "auto-dev-1.2.3/README.md",
      "auto-dev-1.2.3/node_modules/fake-dep/index.js",
    ]) {
      expect(entries).toContain(expected);
    }
    expect(entries.every((entry) => entry.startsWith("auto-dev-1.2.3"))).toBe(true);
    expect(entries.some((entry) => entry.startsWith("auto-dev-1.2.3/src"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("auto-dev-1.2.3/test"))).toBe(false);
    expect(entries.some((entry) => entry.includes("/._"))).toBe(false);
  });

  it("refuses a checkout that has not been built", () => {
    const dir = tempDir();
    const root = fakeBuiltRoot(dir);
    rmSync(path.join(root, "dist"), { recursive: true });

    const result = spawnSync("bash", [script, "--root", root, "--out", path.join(dir, "out")], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm run build");
    expect(existsSync(path.join(dir, "out", "auto-dev-1.2.3.tar.gz"))).toBe(false);
  });

  // Packs this checkout for real: needs `npm run build` first and the npm registry, so it runs only on request.
  it.skipIf(!process.env.AUTO_DEV_PACKAGE_FULL)("packs the real build with argon2 prebuilds for linux and without dev dependencies", { timeout: 600_000 }, () => {
    const out = path.join(tempDir(), "out");
    const archive = execFileSync("bash", [script, "--out", out], { encoding: "utf8" }).trim().split("\n").at(-1) as string;
    const entries = listArchive(archive);
    const top = entries[0]?.split("/")[0] as string;
    expect(entries).toContain(`${top}/node_modules/argon2/prebuilds/linux-x64/argon2.glibc.node`);
    expect(entries).toContain(`${top}/node_modules/argon2/prebuilds/linux-arm64/argon2.armv8.glibc.node`);
    expect(entries).toContain(`${top}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`);
    // The per-platform claude binaries of the SDK would tie the archive to the build host; the system claude is used instead.
    expect(entries.some((entry) => entry.includes("/claude-agent-sdk-"))).toBe(false);
    expect(entries).toContain(`${top}/dist/client/index.html`);
    expect(entries.some((entry) => entry.startsWith(`${top}/node_modules/vitest`))).toBe(false);
    expect(entries.some((entry) => entry.startsWith(`${top}/node_modules/typescript`))).toBe(false);
  });
});
