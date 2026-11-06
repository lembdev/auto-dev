import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type Config, type LoadConfigOptions } from "./config.js";

// Keys of the env file the wizard and the Settings page write.
export const ENV_KEYS = {
  passwordHash: "AUTO_DEV_PASSWORD_HASH",
  githubToken: "GITHUB_TOKEN",
  githubRepo: "GITHUB_REPO",
  oauthToken: "CLAUDE_CODE_OAUTH_TOKEN",
} as const;

export const ENV_FILE_MODE = 0o600;

// Reads and writes the env file; the store never touches the file system directly, so tests keep it in memory.
export type EnvFileAccess = {
  read(filePath: string): string | undefined;
  // Replaces the whole file; it must end up readable by the Installation user only.
  write(filePath: string, content: string): void;
};

export type EnvPatch = Record<string, string | undefined>;

export type ConfigListener = (config: Config, previous: Config) => void;

export type ConfigStoreOptions = Omit<LoadConfigOptions, "readFile"> & {
  files?: EnvFileAccess;
};

const readOptional = (filePath: string): string | undefined => {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

// Secrets go through a temp file in the same directory, so a crash never leaves a half-written env file.
export const nodeEnvFileAccess: EnvFileAccess = {
  read: readOptional,
  write(filePath, content) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temp, content, { mode: ENV_FILE_MODE });
    chmodSync(temp, ENV_FILE_MODE);
    renameSync(temp, filePath);
  },
};

export class MemoryEnvFileAccess implements EnvFileAccess {
  readonly files = new Map<string, string>();
  readonly writes: { filePath: string; content: string }[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [filePath, content] of Object.entries(initial)) this.files.set(filePath, content);
  }

  read(filePath: string): string | undefined {
    return this.files.get(filePath);
  }

  write(filePath: string, content: string): void {
    this.files.set(filePath, content);
    this.writes.push({ filePath, content });
  }
}

// The parser in config.ts strips a pair of quotes and nothing else, so quoting is all the escaping there is.
const needsQuotes = (value: string): boolean => value === "" || /[\s#]/.test(value);

const renderLine = (key: string, value: string): string => (needsQuotes(value) ? `${key}="${value}"` : `${key}=${value}`);

const KEY_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// Applies a patch to the text of an env file: known keys are replaced in place, deleted ones dropped,
// new ones appended. Comments and unknown lines stay where they are.
export function patchEnvFile(content: string | undefined, patch: EnvPatch): string {
  const lines = content === undefined || content === "" ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
  const pending = new Map(Object.entries(patch));
  const result: string[] = [];
  for (const line of lines) {
    const match = KEY_LINE.exec(line.trim());
    const key = match?.[1];
    if (key === undefined || !pending.has(key)) {
      result.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value !== undefined) result.push(renderLine(key, value));
  }
  for (const [key, value] of pending) {
    if (value !== undefined) result.push(renderLine(key, value));
  }
  return result.length === 0 ? "" : `${result.join("\n")}\n`;
}

// The configuration of the Installation as a live object: the env file is the source of truth for
// secrets, every change goes through `update` and reaches subscribers without a restart.
export class ConfigStore {
  private readonly _files: EnvFileAccess;
  private readonly _env: NodeJS.ProcessEnv | undefined;
  private readonly _listeners = new Set<ConfigListener>();
  private _config: Config;

  constructor(options: ConfigStoreOptions = {}) {
    this._files = options.files ?? nodeEnvFileAccess;
    this._env = options.env;
    this._config = this._load();
  }

  current(): Config {
    return this._config;
  }

  onChange(listener: ConfigListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  // Rereads the env file; the process environment still wins over it.
  reload(): Config {
    const previous = this._config;
    this._config = this._load();
    this._notify(previous);
    return this._config;
  }

  // Writes the keys into the env file (undefined removes a key) and reloads.
  update(patch: EnvPatch): Config {
    const envFile = this._config.envFile;
    this._files.write(envFile, patchEnvFile(this._files.read(envFile), patch));
    return this.reload();
  }

  private _load(): Config {
    return loadConfig({ ...(this._env ? { env: this._env } : {}), readFile: (filePath) => this._files.read(filePath) });
  }

  private _notify(previous: Config): void {
    for (const listener of this._listeners) listener(this._config, previous);
  }
}
