import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "../src/index/migrations.js";

const schemaVersion = migrations.at(-1)?.version;

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

type Started = {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

const start = (env: Record<string, string>): Started => {
  const child = spawn(process.execPath, [tsx, path.join(root, "src", "main.ts")], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout, stderr, exited };
};

const logLines = (chunks: string[]): Record<string, unknown>[] =>
  chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const waitForUrl = async (started: Started): Promise<string> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const line = logLines(started.stdout).find((entry) => entry.msg === "server listening");
    if (line) return line.url as string;
    if (started.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start\nstdout: ${started.stdout.join("")}\nstderr: ${started.stderr.join("")}`);
};

describe("auto-dev process", () => {
  const dirs: string[] = [];
  const running: Started[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-main-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const started of running.splice(0)) {
      if (started.child.exitCode === null) started.child.kill("SIGKILL");
      await started.exited;
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("starts, creates runtime.db, serves health, logs JSON at the configured level and restarts on the same index", async () => {
    const dataDir = path.join(tempDir(), "data");
    const env = { AUTO_DEV_DATA_DIR: dataDir, AUTO_DEV_ENV_FILE: path.join(dataDir, "missing-env"), AUTO_DEV_PORT: "0", AUTO_DEV_HOST: "127.0.0.1", LOG_LEVEL: "debug" };

    const first = start(env);
    running.push(first);
    const url = await waitForUrl(first);
    expect(existsSync(path.join(dataDir, "runtime.db"))).toBe(true);
    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", schemaVersion });

    first.child.kill("SIGTERM");
    expect(await first.exited).toEqual({ code: 0, signal: null });
    const lines = logLines(first.stdout);
    expect(lines.find((entry) => entry.msg === "runtime index ready")).toMatchObject({ level: 30, schemaVersion });
    expect(lines.find((entry) => entry.msg === "shutting down")).toMatchObject({ signal: "SIGTERM" });

    const second = start(env);
    running.push(second);
    const secondUrl = await waitForUrl(second);
    expect(await (await fetch(`${secondUrl}/api/health`)).json()).toMatchObject({ status: "ok", schemaVersion });
    second.child.kill("SIGTERM");
    expect((await second.exited).code).toBe(0);
  });

  it("stays quiet below the configured log level", async () => {
    const dataDir = path.join(tempDir(), "data");
    const started = start({ AUTO_DEV_DATA_DIR: dataDir, AUTO_DEV_ENV_FILE: "/nonexistent/env", AUTO_DEV_PORT: "0", AUTO_DEV_HOST: "127.0.0.1", LOG_LEVEL: "error" });
    running.push(started);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    started.child.kill("SIGTERM");
    await started.exited;
    expect(logLines(started.stdout)).toEqual([]);
  });

  it.each(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])("refuses to start with %s in the environment", async (key) => {
    const started = start({ AUTO_DEV_DATA_DIR: tempDir(), AUTO_DEV_ENV_FILE: "/nonexistent/env", [key]: "sk-ant-test" });
    running.push(started);
    expect((await started.exited).code).toBe(1);
    expect(started.stderr.join("")).toContain(`${key} is set in the environment`);
    expect(started.stderr.join("")).toContain("Claude subscription");
  });

  it("refuses to start with ANTHROPIC_API_KEY in the env file", async () => {
    const dir = tempDir();
    const envFile = path.join(dir, "env");
    writeFileSync(envFile, "LOG_LEVEL=info\nANTHROPIC_API_KEY=sk-ant-test\n");
    const started = start({ AUTO_DEV_DATA_DIR: dir, AUTO_DEV_ENV_FILE: envFile });
    running.push(started);
    expect((await started.exited).code).toBe(1);
    expect(started.stderr.join("")).toContain(`ANTHROPIC_API_KEY is set in ${envFile}`);
    expect(existsSync(path.join(dir, "runtime.db"))).toBe(false);
  });
});

describe("first-run wizard in the real process", () => {
  const dirs: string[] = [];
  const running: Started[] = [];
  afterEach(async () => {
    for (const started of running.splice(0)) {
      if (started.child.exitCode === null) started.child.kill("SIGKILL");
      await started.exited;
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the env file with mode 0600 on the password step and resumes from the next step after a restart", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-wizard-"));
    dirs.push(dir);
    const envFile = path.join(dir, "etc", "env");
    const env = { AUTO_DEV_DATA_DIR: path.join(dir, "data"), AUTO_DEV_ENV_FILE: envFile, AUTO_DEV_PORT: "0", AUTO_DEV_HOST: "127.0.0.1" };

    const first = start(env);
    running.push(first);
    const url = await waitForUrl(first);
    expect(await (await fetch(`${url}/api/setup`)).json()).toMatchObject({ required: true, current: "password", passwordSet: false });
    expect((await fetch(`${url}/api/tasks`)).status).toBe(401);
    const password = await fetch(`${url}/api/setup/password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "first run" }) });
    expect(password.status).toBe(200);
    expect(await password.json()).toMatchObject({ current: "repository", passwordSet: true });
    expect(password.headers.get("set-cookie")).toContain("auto_dev_session=");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile, "utf8")).toMatch(/^AUTO_DEV_PASSWORD_HASH=\$argon2id\$/);
    expect(logLines(first.stdout).find((entry) => entry.msg === "first-run setup is not finished; open the UI to continue it")).toMatchObject({ step: "password" });
    first.child.kill("SIGTERM");
    await first.exited;

    const second = start(env);
    running.push(second);
    const secondUrl = await waitForUrl(second);
    expect(await (await fetch(`${secondUrl}/api/setup`)).json()).toMatchObject({ required: true, current: "repository", passwordSet: true });
    // the step routes are behind the login now
    expect((await fetch(`${secondUrl}/api/setup/repository`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const login = await fetch(`${secondUrl}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "first run" }) });
    expect(login.status).toBe(200);
    second.child.kill("SIGTERM");
    await second.exited;
  });
});
