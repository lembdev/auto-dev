import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { codeSchemaVersion, EXIT, PREPARE_TIMEOUT_MS, runCli, updateTokenPath, writeUpdateToken, type CliDeps } from "../src/cli.js";
import { loadConfig, type Config } from "../src/config.js";
import { migrations } from "../src/index/migrations.js";
import { applyMigrations } from "../src/index/runtime-index.js";
import { createTestApp, type TestApp } from "./helpers/test-app.js";

const TOKEN = "local-updater-token";

describe("updater commands of main.js", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const testApp of apps.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  const configIn = (env: Record<string, string> = {}): Config => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-cli-"));
    dirs.push(dir);
    return loadConfig({ env: { AUTO_DEV_ENV_FILE: path.join(dir, "env"), AUTO_DEV_DATA_DIR: dir, ...env } });
  };

  const run = async (command: Parameters<typeof runCli>[0], args: string[], deps: Partial<CliDeps> & { config: Config }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(command, args, { out: (line) => out.push(line), err: (line) => err.push(line), ...deps });
    return { code, out, err };
  };

  it("schema-version prints the latest migration of this release, --db the version of the index on disk", async () => {
    const config = configIn();
    expect((await run("schema-version", [], { config })).out).toEqual([String(migrations.at(-1)?.version)]);
    expect((await run("schema-version", ["--db"], { config })).out).toEqual(["0"]);

    expect((await run("migrate", [], { config })).code).toBe(EXIT.ok);
    expect((await run("schema-version", ["--db"], { config })).out).toEqual([String(codeSchemaVersion())]);
  });

  it("migrate refuses an index newer than the code with its own exit code", async () => {
    const config = configIn();
    const db = new DatabaseSync(config.runtimeDbPath);
    applyMigrations(db, [...migrations, { version: codeSchemaVersion() + 1, up: () => {} }]);
    db.close();

    const result = await run("migrate", [], { config });
    expect(result.code).toBe(EXIT.schemaTooNew);
    expect(result.err.join("\n")).toContain("newer than the supported");
  });

  it("writes the update token readable by its owner only, new on every start", () => {
    const config = configIn();
    const first = writeUpdateToken(config.dataDir);
    const second = writeUpdateToken(config.dataDir);
    expect(second).not.toBe(first);
    expect(readFileSync(updateTokenPath(config.dataDir), "utf8").trim()).toBe(second);
    expect(statSync(updateTokenPath(config.dataDir)).mode & 0o777).toBe(0o600);
  });

  describe("prepare-update", () => {
    const service = (): TestApp => {
      const testApp = createTestApp({ localToken: TOKEN });
      apps.push(testApp);
      return testApp;
    };
    const through = (testApp: TestApp): CliDeps["fetch"] => (url, init) => {
      const { pathname, host } = new URL(url);
      const headers = new Headers(init?.headers);
      headers.set("host", host);
      return testApp.app.request(pathname, { ...init, headers });
    };

    it("pauses the running service with the local token and waits until it is ready", async () => {
      const testApp = service();
      const config = configIn({ AUTO_DEV_PORT: "8080" });
      const result = await run("prepare-update", [], { config, fetch: through(testApp), readFile: () => `${TOKEN}\n`, sleep: async () => {} });
      expect(result).toMatchObject({ code: EXIT.ok, out: ["pause set, waiting for the running turns", "ready for the update"] });
      expect(testApp.orchestrator.installation.findPause()?.source).toBe("update");
    });

    it("tells the script the service is not there to prepare", async () => {
      const config = configIn();
      const refused = async (): Promise<Response> => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
      };
      expect((await run("prepare-update", [], { config, fetch: refused, readFile: () => TOKEN })).code).toBe(EXIT.unreachable);
      expect((await run("prepare-update", [], { config })).code).toBe(EXIT.unreachable);
    });

    it("gives up when the service never gets ready", async () => {
      let now = 0;
      const config = configIn();
      const fetch: CliDeps["fetch"] = async (url) =>
        Response.json(url.endsWith("prepare-update") ? {} : { update: { phase: "preparing" } }, { status: url.endsWith("prepare-update") ? 202 : 200 });
      const result = await run("prepare-update", [], { config, fetch, readFile: () => TOKEN, now: () => now, sleep: async (ms) => void (now += ms) });
      expect(result.code).toBe(EXIT.failed);
      expect(now).toBeGreaterThanOrEqual(PREPARE_TIMEOUT_MS);
    });
  });
});
