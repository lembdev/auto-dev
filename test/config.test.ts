import { describe, expect, it } from "vitest";
import { ConfigError, ForbiddenEnvKeyError, loadConfig, parseEnvFile } from "../src/config.js";

const files = (map: Record<string, string>) => (filePath: string) => map[filePath];

describe("config", () => {
  it("uses the defaults when nothing is set and the env file is missing", () => {
    const config = loadConfig({ env: {}, readFile: () => undefined });
    expect(config).toMatchObject({
      envFile: "/etc/auto-dev/env",
      envFileExists: false,
      dataDir: "/var/lib/auto-dev",
      runtimeDbPath: "/var/lib/auto-dev/runtime.db",
      claudeConfigDir: "/var/lib/auto-dev/claude",
      claudePath: undefined,
      host: "0.0.0.0",
      port: 8080,
      logLevel: "info",
    });
  });

  it("reads the env file from AUTO_DEV_ENV_FILE and lets the process environment override it", () => {
    const config = loadConfig({
      env: { AUTO_DEV_ENV_FILE: "/tmp/env", LOG_LEVEL: "debug" },
      readFile: files({ "/tmp/env": "LOG_LEVEL=warn\nAUTO_DEV_PORT=9090\nGITHUB_TOKEN='ghp_x'\n" }),
    });
    expect(config.envFileExists).toBe(true);
    expect(config.logLevel).toBe("debug");
    expect(config.port).toBe(9090);
    expect(config.values.GITHUB_TOKEN).toBe("ghp_x");
  });

  it("reads the password hash and the extra allowed hosts for the UI", () => {
    const config = loadConfig({
      env: { AUTO_DEV_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=4$abc$def", AUTO_DEV_ALLOWED_HOSTS: "auto-dev.example.com:8080, Box.Home " },
      readFile: () => undefined,
    });
    expect(config.passwordHash).toBe("$argon2id$v=19$m=65536,t=3,p=4$abc$def");
    expect(config.allowedHosts).toEqual(["auto-dev.example.com:8080", "box.home"]);
    const bare = loadConfig({ env: { AUTO_DEV_PASSWORD_HASH: "" }, readFile: () => undefined });
    expect(bare.passwordHash).toBeUndefined();
    expect(bare.allowedHosts).toEqual([]);
  });

  it("takes the Claude config dir and the claude path from the environment", () => {
    const config = loadConfig({
      env: { CLAUDE_CONFIG_DIR: "/home/dev/.claude", AUTO_DEV_CLAUDE_PATH: "/usr/local/bin/claude" },
      readFile: () => undefined,
    });
    expect(config.claudeConfigDir).toBe("/home/dev/.claude");
    expect(config.claudePath).toBe("/usr/local/bin/claude");
  });

  it("parses GITHUB_REPO as owner/name together with GITHUB_TOKEN", () => {
    const config = loadConfig({ env: { GITHUB_TOKEN: "ghp_x", GITHUB_REPO: "acme/product" }, readFile: () => undefined });
    expect(config.github).toEqual({ token: "ghp_x", owner: "acme", repo: "product" });
    expect(loadConfig({ env: {}, readFile: () => undefined }).github).toBeUndefined();
    expect(loadConfig({ env: { GITHUB_TOKEN: "ghp_x" }, readFile: () => undefined }).github).toBeUndefined();
    expect(() => loadConfig({ env: { GITHUB_TOKEN: "ghp_x", GITHUB_REPO: "https://github.com/acme/product" }, readFile: () => undefined })).toThrow(
      'GITHUB_REPO must be "owner/name"',
    );
  });

  it.each(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])("refuses to start with %s in the environment", (key) => {
    expect(() => loadConfig({ env: { [key]: "sk-ant" }, readFile: () => undefined })).toThrow(ForbiddenEnvKeyError);
    expect(() => loadConfig({ env: { [key]: "sk-ant" }, readFile: () => undefined })).toThrow(
      `${key} is set in the environment`,
    );
  });

  it.each(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])("refuses to start with %s in the env file", (key) => {
    const load = () =>
      loadConfig({ env: { AUTO_DEV_ENV_FILE: "/etc/auto-dev/env" }, readFile: files({ "/etc/auto-dev/env": `${key}=x\n` }) });
    expect(load).toThrow(ForbiddenEnvKeyError);
    expect(load).toThrow(`${key} is set in /etc/auto-dev/env`);
    expect(load).toThrow("Claude subscription");
  });

  it("rejects an unknown log level and a bad port with a clear message", () => {
    expect(() => loadConfig({ env: { LOG_LEVEL: "loud" }, readFile: () => undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { LOG_LEVEL: "loud" }, readFile: () => undefined })).toThrow("LOG_LEVEL must be one of");
    expect(() => loadConfig({ env: { AUTO_DEV_PORT: "http" }, readFile: () => undefined })).toThrow("AUTO_DEV_PORT must be");
  });

  it("parses KEY=VALUE files with comments, quotes and export prefixes", () => {
    expect(
      parseEnvFile(
        ["# comment", "", "A=1", "export B=two", 'C="quoted # not a comment"', "D='single'", "E=bare # trailing comment", "garbage line"].join(
          "\n",
        ),
      ),
    ).toEqual({ A: "1", B: "two", C: "quoted # not a comment", D: "single", E: "bare" });
  });
});
