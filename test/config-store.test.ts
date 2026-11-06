import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, MemoryEnvFileAccess, nodeEnvFileAccess, patchEnvFile } from "../src/config-store.js";
import { parseEnvFile } from "../src/config.js";

const ENV_FILE = "/etc/auto-dev/env";

const store = (content?: string, env: NodeJS.ProcessEnv = {}) => {
  const files = new MemoryEnvFileAccess(content === undefined ? {} : { [ENV_FILE]: content });
  return { files, store: new ConfigStore({ files, env: { AUTO_DEV_ENV_FILE: ENV_FILE, ...env } }) };
};

describe("patchEnvFile", () => {
  it("replaces keys in place, drops deleted ones, appends new ones and keeps comments", () => {
    const before = "# secrets of the Installation\nGITHUB_REPO=acme/old\nexport GITHUB_TOKEN=ghp_old\nLOG_LEVEL=debug\n";
    const after = patchEnvFile(before, { GITHUB_REPO: "acme/product", GITHUB_TOKEN: undefined, AUTO_DEV_PASSWORD_HASH: "$argon2id$x" });
    expect(after).toBe("# secrets of the Installation\nGITHUB_REPO=acme/product\nLOG_LEVEL=debug\nAUTO_DEV_PASSWORD_HASH=$argon2id$x\n");
  });

  it("quotes values with spaces or hashes so the parser reads them back unchanged", () => {
    const content = patchEnvFile(undefined, { A: "with space", B: "value#not-comment", C: "", D: "plain" });
    expect(parseEnvFile(content)).toEqual({ A: "with space", B: "value#not-comment", C: "", D: "plain" });
  });
});

describe("ConfigStore", () => {
  it("starts without an env file and reports it", () => {
    const { store: configStore } = store();
    expect(configStore.current().envFileExists).toBe(false);
    expect(configStore.current().passwordHash).toBeUndefined();
    expect(configStore.current().github).toBeUndefined();
  });

  it("writes an update to the env file, reloads and notifies listeners with the previous config", () => {
    const { files, store: configStore } = store("LOG_LEVEL=debug\n");
    const seen: { github: string | undefined; previous: string | undefined }[] = [];
    configStore.onChange((config, previous) => seen.push({ github: config.github?.repo, previous: previous.github?.repo }));

    const updated = configStore.update({ GITHUB_REPO: "acme/product", GITHUB_TOKEN: "ghp_new" });
    expect(updated.github).toEqual({ owner: "acme", repo: "product", token: "ghp_new" });
    expect(updated.envFileExists).toBe(true);
    expect(updated.logLevel).toBe("debug");
    expect(files.read(ENV_FILE)).toBe("LOG_LEVEL=debug\nGITHUB_REPO=acme/product\nGITHUB_TOKEN=ghp_new\n");
    expect(seen).toEqual([{ github: "product", previous: undefined }]);
    expect(configStore.current()).toBe(updated);
  });

  it("keeps the process environment on top of the file", () => {
    const { store: configStore } = store("AUTO_DEV_PORT=9000\n", { AUTO_DEV_PORT: "1234" });
    expect(configStore.current().port).toBe(1234);
    configStore.update({ AUTO_DEV_PORT: "9001" });
    expect(configStore.current().port).toBe(1234);
  });

  it("removes a key when the patch value is undefined", () => {
    const { files, store: configStore } = store("AUTO_DEV_PASSWORD_HASH=$argon2id$x\n");
    expect(configStore.current().passwordHash).toBe("$argon2id$x");
    configStore.update({ AUTO_DEV_PASSWORD_HASH: undefined });
    expect(configStore.current().passwordHash).toBeUndefined();
    expect(files.read(ENV_FILE)).toBe("");
  });
});

describe("nodeEnvFileAccess", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory and the file with mode 0600, and rewrites it atomically", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-env-"));
    dirs.push(dir);
    const envFile = path.join(dir, "etc", "env");
    expect(nodeEnvFileAccess.read(envFile)).toBeUndefined();
    nodeEnvFileAccess.write(envFile, "GITHUB_TOKEN=ghp_one\n");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile, "utf8")).toBe("GITHUB_TOKEN=ghp_one\n");
    nodeEnvFileAccess.write(envFile, "GITHUB_TOKEN=ghp_two\n");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(nodeEnvFileAccess.read(envFile)).toBe("GITHUB_TOKEN=ghp_two\n");
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
