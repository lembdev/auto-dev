import { readFileSync } from "node:fs";
import path from "node:path";
import { isLogLevel, type LogLevel } from "./log.js";

export const DEFAULT_ENV_FILE = "/etc/auto-dev/env";
export const DEFAULT_DATA_DIR = "/var/lib/auto-dev";
export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = "0.0.0.0";

// The Installation runs only under a Claude subscription; these would switch the CLI to API billing.
export const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export type Config = {
  envFile: string;
  // True when the env file exists; without it the first-run wizard takes over.
  envFileExists: boolean;
  dataDir: string;
  runtimeDbPath: string;
  // Clone of the Product; worktrees of Tasks live inside it.
  repoPath: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  // GitHub access of the Installation; both are set by the first-run wizard, so they may be missing.
  github: GitHubConfig | undefined;
  // Merged values: env file first, then the process environment on top.
  values: Readonly<Record<string, string>>;
};

export type GitHubConfig = {
  token: string;
  owner: string;
  repo: string;
};

export const cloneUrlOf = (github: GitHubConfig): string => `https://github.com/${github.owner}/${github.repo}.git`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ForbiddenEnvKeyError extends ConfigError {
  constructor(
    readonly key: string,
    readonly source: string,
  ) {
    super(
      `${key} is set in ${source}. auto-dev works only under a Claude subscription (OAuth token from "claude setup-token") and refuses to start with API credentials present. Remove ${key} and start again.`,
    );
    this.name = "ForbiddenEnvKeyError";
  }
}

export type LoadConfigOptions = {
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string | undefined;
};

const readOptionalFile = (filePath: string): string | undefined => {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

// KEY=VALUE per line, `#` comments, optional single or double quotes around the value.
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue ?? "";
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2] ?? "";
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[key as string] = value;
  }
  return values;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readOptionalFile;
  const envFile = env.AUTO_DEV_ENV_FILE ?? DEFAULT_ENV_FILE;
  const fileContent = readFile(envFile);
  const fileValues = fileContent === undefined ? {} : parseEnvFile(fileContent);

  for (const key of FORBIDDEN_ENV_KEYS) {
    if (env[key] !== undefined) throw new ForbiddenEnvKeyError(key, "the environment");
    if (fileValues[key] !== undefined) throw new ForbiddenEnvKeyError(key, envFile);
  }

  const values: Record<string, string> = { ...fileValues };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) values[key] = value;
  }

  const dataDir = values.AUTO_DEV_DATA_DIR ?? DEFAULT_DATA_DIR;
  const port = parsePort(values.AUTO_DEV_PORT);
  const logLevel = parseLogLevel(values.LOG_LEVEL);
  const github = parseGitHub(values.GITHUB_TOKEN, values.GITHUB_REPO);

  return {
    envFile,
    envFileExists: fileContent !== undefined,
    dataDir,
    runtimeDbPath: path.join(dataDir, "runtime.db"),
    repoPath: path.join(dataDir, "repo"),
    host: values.AUTO_DEV_HOST ?? DEFAULT_HOST,
    port,
    logLevel,
    github,
    values,
  };
}

// `GITHUB_REPO` is `owner/name`. The wizard stores the values one step at a time, so a half-filled
// pair is not an error: the Orchestrator just stays idle until both are there.
const parseGitHub = (token: string | undefined, repo: string | undefined): GitHubConfig | undefined => {
  if (!token || !repo) return undefined;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim());
  if (!match) throw new ConfigError(`GITHUB_REPO must be "owner/name", got "${repo}"`);
  return { token, owner: match[1] as string, repo: match[2] as string };
};

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new ConfigError(`AUTO_DEV_PORT must be a port number, got "${raw}"`);
  return port;
};

const parseLogLevel = (raw: string | undefined): LogLevel => {
  if (raw === undefined || raw === "") return "info";
  const level = raw.toLowerCase();
  if (!isLogLevel(level)) throw new ConfigError(`LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent; got "${raw}"`);
  return level;
};
