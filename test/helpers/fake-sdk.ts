import type { HookCallback, Options, Query, SDKMessage, SDKUserMessage, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { QueryFn, SpawnedClaude } from "../../src/adapters/driver.js";

// A `claude` child as the SDK would spawn it: exits when stdin closes or on a fatal signal.
export class FakeClaudeChild extends EventEmitter implements SpawnedClaude {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(
    readonly pid: number,
    private readonly _ignoresSigterm: boolean,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this._ignoresSigterm) return true;
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.killed = signal !== null;
    this.exitCode = code;
    this.signalCode = signal;
    setImmediate(() => this.emit("exit", code, signal));
  }
}

export type FakeQueryCall = {
  options: Options;
  spawn: SpawnOptions | undefined;
  child: FakeClaudeChild | undefined;
  // User messages the Driver pushed into the input stream, in order.
  inputs: SDKUserMessage[];
  inputClosed: boolean;
  interrupts: number;
  closes: number;
  emit(message: SDKMessage): void;
  // Ends the message stream the way the CLI does when it exits on its own.
  end(exit?: { code: number | null; signal: NodeJS.Signals | null }): void;
  preToolUse(): HookCallback;
};

export type FakeSdkOptions = {
  pid?: number;
  ignoresSigterm?: boolean;
  // Messages the process emits right after spawn.
  script?: SDKMessage[];
  // Whether the fake CLI exits on its own once stdin closes.
  exitOnInputClose?: boolean;
};

// `query()` stand-in: records the call, spawns a fake child through the Driver's spawner, and lets the
// test script the messages the SDK would yield.
export function createFakeSdk(defaults: FakeSdkOptions = {}) {
  const calls: FakeQueryCall[] = [];
  let nextPid = defaults.pid ?? 4242;

  const query: QueryFn = ({ prompt, options = {} }) => {
    const queue: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const call: FakeQueryCall = {
      options,
      spawn: undefined,
      child: undefined,
      inputs: [],
      inputClosed: false,
      interrupts: 0,
      closes: 0,
      emit(message) {
        queue.push(message);
        wake?.();
      },
      end(exit = { code: 0, signal: null }) {
        if (ended) return;
        ended = true;
        call.child?.exit(exit.code, exit.signal);
        wake?.();
      },
      preToolUse() {
        const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
        if (!hook) throw new Error("no PreToolUse hook registered");
        return hook;
      },
    };
    calls.push(call);

    if (options.spawnClaudeCodeProcess) {
      const spawnOptions: SpawnOptions = {
        command: options.pathToClaudeCodeExecutable ?? "claude",
        args: ["--output-format", "stream-json", "--input-format", "stream-json", ...(options.resume ? ["--resume", options.resume] : [])],
        env: options.env ?? {},
        signal: new AbortController().signal,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      };
      call.spawn = spawnOptions;
      call.child = options.spawnClaudeCodeProcess(spawnOptions) as FakeClaudeChild;
      nextPid++;
    }
    for (const message of defaults.script ?? []) call.emit(message);

    void (async () => {
      if (typeof prompt === "string") return;
      for await (const message of prompt) call.inputs.push(message);
      call.inputClosed = true;
      if (defaults.exitOnInputClose ?? true) call.end();
    })();

    const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    })();

    const control = {
      interrupt: async () => {
        call.interrupts++;
        return undefined;
      },
      close: () => {
        call.closes++;
        call.child?.kill("SIGTERM");
        if (!call.child) call.end({ code: null, signal: "SIGTERM" });
      },
    };
    return Object.assign(stream, control) as unknown as Query;
  };

  return {
    query,
    calls,
    lastCall(): FakeQueryCall {
      const last = calls.at(-1);
      if (!last) throw new Error("query was not called");
      return last;
    },
    spawn: (_command: string, _args: string[], _options: { cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal }): SpawnedClaude =>
      new FakeClaudeChild(nextPid, defaults.ignoresSigterm ?? false),
  };
}
