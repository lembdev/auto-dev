import {
  AbortError,
  getSessionMessages as sdkGetSessionMessages,
  query as sdkQuery,
  type HookCallback,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  type Settings,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type { Pid, SessionId } from "../ids.js";
import type { Logger } from "../log.js";
import type {
  AgentLaunch,
  AgentProcess,
  AskHumanDecision,
  DriverPort,
  ProcessExit,
  SessionHistoryOptions,
} from "../ports/driver.js";
import { buildAgentEnv, type AgentEnvSource } from "./agent-env.js";
import { ASK_HUMAN_SERVER, ASK_HUMAN_TOOL_NAME, type AskHumanInput } from "./ask-human.js";

export type QueryFn = typeof sdkQuery;
export type GetSessionMessagesFn = typeof sdkGetSessionMessages;

// A spawned `claude` child: what the SDK needs plus pid and stderr for the Driver's own bookkeeping.
export type SpawnedClaude = SpawnedProcess & { pid?: number | undefined; stderr?: Readable | null };
export type SpawnFn = (command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) => SpawnedClaude;
export type ExecFn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

export const DEFAULT_STOP_GRACE_MS = 2_000;
export const DEFAULT_INTERRUPT_TIMEOUT_MS = 15_000;

export type SdkDriverOptions = {
  envSource: AgentEnvSource;
  // Arguments after `node` that start the stdio server of the `ask_human` tool.
  askHumanServerArgs: string[];
  log: Logger;
  // Absolute path of the system `claude`; resolved from the Agent PATH when omitted.
  claudePath?: string | undefined;
  // Settings every Agent process gets as its "flag settings" layer (statusline and the like);
  // they live only in the process, never in the Product's files.
  settings?: Settings;
  isRoot?: () => boolean;
  // Seams for tests: the real SDK, child_process and `claude --version` otherwise.
  query?: QueryFn;
  getSessionMessages?: GetSessionMessagesFn;
  spawn?: SpawnFn;
  exec?: ExecFn;
  // How long stop() waits for a clean exit after closing stdin before SIGTERM.
  stopGraceMs?: number;
  interruptTimeoutMs?: number;
};

export class RootUserError extends Error {
  constructor() {
    super("Agents run with allowDangerouslySkipPermissions, which the CLI refuses under root; run the Installation as a regular user");
    this.name = "RootUserError";
  }
}

export class ClaudeNotFoundError extends Error {
  constructor(readonly searchPath: string) {
    super(`claude executable not found on PATH (${searchPath}); install Claude Code or set AUTO_DEV_CLAUDE_PATH`);
    this.name = "ClaudeNotFoundError";
  }
}

export class ProcessNotRunningError extends Error {
  constructor() {
    super("Agent process is not running");
    this.name = "ProcessNotRunningError";
  }
}

const defaultIsRoot = (): boolean => typeof process.getuid === "function" && process.getuid() === 0;

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

const execFileAsync = promisify(execFile);
const defaultExec: ExecFn = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, args, { env: options.env, timeout: 30_000 });
  return { stdout };
};

export function findClaudeExecutable(searchPath: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, "claude");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

// Input stream of a streaming-mode query: stays open between Turns so the process can idle and
// accept the next user message; closing it is the graceful way to end the process.
class InputStream implements AsyncIterable<SDKUserMessage> {
  private readonly _queue: SDKUserMessage[] = [];
  private _wake: (() => void) | undefined;
  private _closed = false;

  push(message: SDKUserMessage): void {
    if (this._closed) throw new ProcessNotRunningError();
    this._queue.push(message);
    this._wake?.();
  }

  close(): void {
    this._closed = true;
    this._wake?.();
  }

  get closed(): boolean {
    return this._closed;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    for (;;) {
      const next = this._queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this._closed) return;
      await new Promise<void>((resolve) => {
        this._wake = resolve;
      });
      this._wake = undefined;
    }
  }
}

const userMessage = (text: string, sessionId: SessionId | undefined): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  ...(sessionId ? { session_id: sessionId } : {}),
});

const isDeferredResult = (message: SDKMessage): boolean =>
  message.type === "result" && message.subtype === "success" && message.terminal_reason === "tool_deferred";

class ChildTracker {
  pid: Pid | undefined;
  exit: ProcessExit | undefined;
  child: SpawnedClaude | undefined;
  private _resolveExit!: (exit: ProcessExit) => void;
  readonly exited = new Promise<ProcessExit>((resolve) => {
    this._resolveExit = resolve;
  });

  attach(child: SpawnedClaude): void {
    this.child = child;
    this.pid = child.pid === undefined ? undefined : (child.pid as Pid);
    child.once("exit", (code, signal) => this.finish({ code, signal }));
    child.once("error", () => this.finish({ code: null, signal: null }));
  }

  finish(exit: ProcessExit): void {
    if (this.exit) return;
    this.exit = exit;
    this.pid = undefined;
    this._resolveExit(exit);
  }
}

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

class SdkAgentProcess implements AgentProcess {
  private _sessionId: SessionId | undefined;
  private _turnActive: boolean;
  private _streamEnded = false;

  constructor(
    private readonly _query: Query,
    private readonly _input: InputStream,
    private readonly _child: ChildTracker,
    private readonly _log: Logger,
    private readonly _timeouts: { stopGraceMs: number; interruptTimeoutMs: number },
    launch: AgentLaunch,
  ) {
    this._sessionId = launch.resume;
    this._turnActive = launch.prompt !== undefined || launch.resume !== undefined;
  }

  async *messages(): AsyncIterable<SDKMessage> {
    let lastWasResult = false;
    try {
      for await (const message of this._query) {
        if ("session_id" in message && typeof message.session_id === "string") this._sessionId = message.session_id as SessionId;
        if (message.type === "result") this._turnActive = false;
        if (isDeferredResult(message)) this._input.close();
        lastWasResult = message.type === "result";
        yield message;
      }
    } catch (error) {
      if (error instanceof AbortError) return;
      // After an error result the SDK also throws; the result message already told the consumer everything.
      if (!lastWasResult) throw error;
      this._log.debug({ err: error }, "query ended after an error result");
    } finally {
      this._streamEnded = true;
      // Without a spawned child (startup failure) there is no exit event to wait for.
      if (!this._child.child) this._child.finish({ code: null, signal: null });
    }
  }

  sessionId(): SessionId | undefined {
    return this._sessionId;
  }

  pid(): Pid | undefined {
    return this._child.pid;
  }

  async send(text: string): Promise<void> {
    if (this._child.exit || this._streamEnded) throw new ProcessNotRunningError();
    this._turnActive = true;
    this._input.push(userMessage(text, this._sessionId));
  }

  async interrupt(): Promise<void> {
    if (this._child.exit || !this._turnActive) return;
    try {
      await withTimeout(this._query.interrupt(), this._timeouts.interruptTimeoutMs);
    } catch (error) {
      this._log.warn({ err: error, pid: this._child.pid }, "interrupt failed");
    }
  }

  async stop(): Promise<ProcessExit> {
    if (this._child.exit) return this._child.exit;
    await this.interrupt();
    this._input.close();
    const clean = await withTimeout(this._child.exited, this._timeouts.stopGraceMs);
    if (clean) return clean;
    // close() sends SIGTERM and escalates to SIGKILL on its own after a few seconds.
    try {
      this._query.close();
    } catch (error) {
      this._log.warn({ err: error, pid: this._child.pid }, "close failed, killing the child directly");
      this._child.child?.kill("SIGTERM");
    }
    return this._child.exited;
  }

  exited(): Promise<ProcessExit> {
    return this._child.exited;
  }
}

// DriverPort over the Claude Agent SDK: one `query()` in streaming input mode per Agent process.
export class SdkDriver implements DriverPort {
  private readonly _query: QueryFn;
  private readonly _getSessionMessages: GetSessionMessagesFn;
  private readonly _spawn: SpawnFn;
  private readonly _exec: ExecFn;
  private readonly _isRoot: () => boolean;
  private readonly _timeouts: { stopGraceMs: number; interruptTimeoutMs: number };

  constructor(private readonly _options: SdkDriverOptions) {
    this._query = _options.query ?? sdkQuery;
    this._getSessionMessages = _options.getSessionMessages ?? sdkGetSessionMessages;
    this._spawn = _options.spawn ?? defaultSpawn;
    this._exec = _options.exec ?? defaultExec;
    this._isRoot = _options.isRoot ?? defaultIsRoot;
    this._timeouts = {
      stopGraceMs: _options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      interruptTimeoutMs: _options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS,
    };
  }

  claudePath(): string {
    if (this._options.claudePath) return this._options.claudePath;
    const found = findClaudeExecutable(this._options.envSource.PATH);
    if (!found) throw new ClaudeNotFoundError(this._options.envSource.PATH);
    return found;
  }

  launch(launch: AgentLaunch): AgentProcess {
    if (this._isRoot()) throw new RootUserError();
    const claudePath = this.claudePath();
    const env = buildAgentEnv(this._options.envSource, {
      ...(launch.resumeInterruptedTurn ? { resumeInterruptedTurn: true } : {}),
      ...(launch.env ? { extra: launch.env } : {}),
    });
    const input = new InputStream();
    const child = new ChildTracker();
    const log = this._options.log.child({ cwd: launch.cwd, resume: launch.resume });

    const options: Options = {
      pathToClaudeCodeExecutable: claudePath,
      cwd: launch.cwd,
      env,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: ["AskUserQuestion"],
      strictMcpConfig: true,
      includePartialMessages: true,
      forwardSubagentText: true,
      mcpServers: {
        [ASK_HUMAN_SERVER]: { type: "stdio", command: process.execPath, args: [...this._options.askHumanServerArgs], alwaysLoad: true },
      },
      hooks: { PreToolUse: [{ matcher: ASK_HUMAN_TOOL_NAME, hooks: [this._askHumanHook(launch)] }] },
      spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
        const spawned = this._spawn(spawnOptions.command, spawnOptions.args, {
          ...(spawnOptions.cwd !== undefined ? { cwd: spawnOptions.cwd } : {}),
          env: spawnOptions.env,
          signal: spawnOptions.signal,
        });
        child.attach(spawned);
        spawned.stderr?.on("data", (chunk: Buffer | string) => log.debug({ pid: spawned.pid, stderr: chunk.toString().trimEnd() }, "claude stderr"));
        log.info({ pid: spawned.pid }, "claude process spawned");
        return spawned;
      },
      ...(launch.resume ? { resume: launch.resume } : {}),
      ...(launch.model ? { model: launch.model } : {}),
      ...(this._options.settings ? { settings: structuredClone(this._options.settings) } : {}),
    };

    if (launch.prompt !== undefined) input.push(userMessage(launch.prompt, launch.resume));
    const query = this._query({ prompt: input, options });
    void child.exited.then((exit) => log.info({ ...exit }, "claude process exited"));
    return new SdkAgentProcess(query, input, child, log, this._timeouts, launch);
  }

  async getSessionHistory(sessionId: SessionId, options: SessionHistoryOptions = {}): Promise<SDKMessage[]> {
    const messages = await this._getSessionMessages(sessionId, options.cwd ? { dir: options.cwd } : {});
    return messages.flatMap((message) => {
      const converted = toSdkMessage(message);
      return converted ? [converted] : [];
    });
  }

  async getClaudeVersion(): Promise<string> {
    const { stdout } = await this._exec(this.claudePath(), ["--version"], { env: buildAgentEnv(this._options.envSource) });
    const match = /\d+\.\d+\.\d+/.exec(stdout);
    if (!match) throw new Error(`cannot parse claude version from "${stdout.trim()}"`);
    return match[0];
  }

  private _askHumanHook(launch: AgentLaunch): HookCallback {
    return async (input, toolUseId) => {
      if (input.hook_event_name !== "PreToolUse" || input.tool_name !== ASK_HUMAN_TOOL_NAME) return {};
      const toolInput = (input.tool_input ?? {}) as AskHumanInput;
      if (!launch.onAskHuman) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "ask_human is not available in this session",
          },
        };
      }
      const decision = await launch.onAskHuman({
        toolUseId: toolUseId ?? input.tool_use_id,
        question: toolInput.question,
        options: toolInput.options,
      });
      return { hookSpecificOutput: { hookEventName: "PreToolUse", ...askHumanOutput(toolInput, decision) } };
    };
  }
}

const askHumanOutput = (
  toolInput: AskHumanInput,
  decision: AskHumanDecision,
): { permissionDecision: "defer" | "allow"; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } => {
  if (decision.kind === "defer") return { permissionDecision: "defer", permissionDecisionReason: "waiting for the human" };
  return {
    permissionDecision: "allow",
    updatedInput: { ...toolInput, answer: decision.answer, ...(decision.source ? { source: decision.source } : {}) },
  };
};

type HistoryUser = SDKUserMessage;
type HistoryAssistant = Extract<SDKMessage, { type: "assistant" }>;
type Uuid = HistoryAssistant["uuid"];

// Transcript entries carry the API message; system entries have no SDKMessage shape and are dropped.
export function toSdkMessage(entry: SessionMessage): SDKMessage | undefined {
  const uuid = entry.uuid as Uuid;
  if (entry.type === "user") {
    const message: HistoryUser = {
      type: "user",
      message: entry.message as HistoryUser["message"],
      parent_tool_use_id: entry.parent_tool_use_id,
      uuid,
      session_id: entry.session_id,
    };
    return message;
  }
  if (entry.type === "assistant") {
    const message: HistoryAssistant = {
      type: "assistant",
      message: entry.message as HistoryAssistant["message"],
      parent_tool_use_id: entry.parent_tool_use_id,
      uuid,
      session_id: entry.session_id,
    };
    return message;
  }
  return undefined;
}
