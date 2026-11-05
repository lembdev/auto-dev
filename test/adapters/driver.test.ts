import type { PreToolUseHookInput, SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import { ClaudeNotFoundError, ProcessNotRunningError, RootUserError, SdkDriver, type SdkDriverOptions } from "../../src/adapters/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { SessionId } from "../../src/ids.js";
import { createLogger } from "../../src/log.js";
import type { AskHumanCall, AskHumanDecision } from "../../src/ports/driver.js";
import { createFakeSdk, type FakeSdkOptions } from "../helpers/fake-sdk.js";

const SESSION = "22222222-2222-4222-8222-222222222222" as SessionId;
const envSource = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/auto-dev",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
  CLAUDE_CONFIG_DIR: "/var/lib/auto-dev/claude",
  GH_TOKEN: "ghp_test",
};

const createDriver = (fake: FakeSdkOptions = {}, overrides: Partial<SdkDriverOptions> = {}) => {
  const sdk = createFakeSdk(fake);
  const driver = new SdkDriver({
    envSource,
    askHumanServerArgs: ["/opt/auto-dev/current/dist/adapters/ask-human-mcp.js"],
    claudePath: "/usr/local/bin/claude",
    log: createLogger({ level: "silent" }),
    isRoot: () => false,
    query: sdk.query,
    spawn: sdk.spawn,
    stopGraceMs: 30,
    interruptTimeoutMs: 30,
    ...overrides,
  });
  return { driver, sdk };
};

const collect = async (iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> => {
  const items: SDKMessage[] = [];
  for await (const item of iterable) items.push(item);
  return items;
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const preToolUseInput = (toolInput: unknown, toolName = ASK_HUMAN_TOOL_NAME): PreToolUseHookInput => ({
  hook_event_name: "PreToolUse",
  session_id: SESSION,
  transcript_path: "/tmp/t.jsonl",
  cwd: "/w",
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: "toolu_01",
});

describe("SdkDriver.launch", () => {
  it("starts a streaming query with the spec options and the prompt as the first user message", async () => {
    const { driver, sdk } = createDriver();
    const process = driver.launch({ cwd: "/repo/.claude/worktrees/issue-7", prompt: "implement the issue" });
    await tick();

    const call = sdk.lastCall();
    expect(call.options).toMatchObject({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      cwd: "/repo/.claude/worktrees/issue-7",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: ["AskUserQuestion"],
      strictMcpConfig: true,
      includePartialMessages: true,
      forwardSubagentText: true,
    });
    expect(call.options.resume).toBeUndefined();
    expect(call.options.mcpServers).toEqual({
      human: { type: "stdio", command: globalThis.process.execPath, args: ["/opt/auto-dev/current/dist/adapters/ask-human-mcp.js"], alwaysLoad: true },
    });
    expect(call.options.hooks?.PreToolUse?.[0]?.matcher).toBe(ASK_HUMAN_TOOL_NAME);
    expect(call.inputs).toEqual([{ type: "user", message: { role: "user", content: "implement the issue" }, parent_tool_use_id: null }]);
    expect(call.inputClosed).toBe(false);
    expect(process.pid()).toBe(4242);
    expect(process.sessionId()).toBeUndefined();
  });

  it("hands the Agent exactly the listed environment", async () => {
    const { driver, sdk } = createDriver();
    driver.launch({ cwd: "/w", prompt: "go", env: { AUTO_DEV_ROLE: "qa" } });
    expect(sdk.lastCall().options.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/auto-dev",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      CLAUDE_CONFIG_DIR: "/var/lib/auto-dev/claude",
      GH_TOKEN: "ghp_test",
      CLAUDE_CODE_RETRY_WATCHDOG: "1",
      AUTO_DEV_ROLE: "qa",
    });
    expect(sdk.lastCall().spawn?.env).toBe(sdk.lastCall().options.env);
  });

  it("resumes a Session with an open input stream and no message", async () => {
    const { driver, sdk } = createDriver();
    const process = driver.launch({ cwd: "/w", resume: SESSION, resumeInterruptedTurn: true });
    await tick();
    const call = sdk.lastCall();
    expect(call.options.resume).toBe(SESSION);
    expect(call.options.env?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");
    expect(call.inputs).toEqual([]);
    expect(call.inputClosed).toBe(false);
    expect(process.sessionId()).toBe(SESSION);
  });

  it("refuses to launch under root", () => {
    const { driver, sdk } = createDriver({}, { isRoot: () => true });
    expect(() => driver.launch({ cwd: "/w", prompt: "go" })).toThrow(RootUserError);
    expect(sdk.calls).toHaveLength(0);
  });

  it("refuses to launch when claude is not on the Agent PATH", () => {
    const { driver, sdk } = createDriver({}, { claudePath: undefined, envSource: { ...envSource, PATH: "/nonexistent" } });
    expect(() => driver.launch({ cwd: "/w", prompt: "go" })).toThrow(ClaudeNotFoundError);
    expect(sdk.calls).toHaveLength(0);
  });
});

describe("SdkDriver process", () => {
  it("streams SDK messages, learns the session id and reports the exit", async () => {
    const { driver, sdk } = createDriver();
    const process = driver.launch({ cwd: "/w", prompt: "go" });
    const received = collect(process.messages());
    const call = sdk.lastCall();
    call.emit(sdkMessages.init(SESSION));
    call.emit(sdkMessages.assistantText(SESSION, "hello"));
    call.emit(sdkMessages.resultSuccess(SESSION, "hello"));
    await tick();
    expect(process.sessionId()).toBe(SESSION);

    call.end({ code: 0, signal: null });
    expect((await received).map((message) => message.type)).toEqual(["system", "assistant", "result"]);
    expect(await process.exited()).toEqual({ code: 0, signal: null });
    expect(process.pid()).toBeUndefined();
  });

  it("sends follow-up messages into the live input stream", async () => {
    const { driver, sdk } = createDriver();
    const process = driver.launch({ cwd: "/w", prompt: "go" });
    void collect(process.messages());
    const call = sdk.lastCall();
    call.emit(sdkMessages.init(SESSION));
    call.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await tick();

    await process.send("continue with the tests");
    await tick();
    expect(call.inputs.map((message) => message.message.content)).toEqual(["go", "continue with the tests"]);
    expect(call.inputs[1]?.session_id).toBe(SESSION);

    call.end();
    await process.exited();
    await expect(process.send("too late")).rejects.toThrow(ProcessNotRunningError);
  });

  it("stops a running Turn with interrupt, closes stdin and lets the CLI exit", async () => {
    const { driver, sdk } = createDriver();
    const process = driver.launch({ cwd: "/w", prompt: "go" });
    void collect(process.messages());
    const call = sdk.lastCall();
    call.emit(sdkMessages.init(SESSION));
    await tick();

    expect(await process.stop()).toEqual({ code: 0, signal: null });
    expect(call.interrupts).toBe(1);
    expect(call.inputClosed).toBe(true);
    expect(call.closes).toBe(0);
    expect(call.child?.signals).toEqual([]);
  });

  it("skips interrupt for an idle process and sends SIGTERM when the CLI does not exit", async () => {
    const { driver, sdk } = createDriver({ exitOnInputClose: false });
    const process = driver.launch({ cwd: "/w", prompt: "go" });
    void collect(process.messages());
    const call = sdk.lastCall();
    call.emit(sdkMessages.init(SESSION));
    call.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await tick();

    expect(await process.stop()).toEqual({ code: null, signal: "SIGTERM" });
    expect(call.interrupts).toBe(0);
    expect(call.closes).toBe(1);
    expect(call.child?.signals).toEqual(["SIGTERM"]);
    expect(await process.stop()).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("ends the stream quietly when the SDK throws after an error result, but surfaces startup failures", async () => {
    const { driver, sdk } = createDriver();
    const process = driver.launch({ cwd: "/w", prompt: "go" });
    const received = collect(process.messages());
    const call = sdk.lastCall();
    call.emit(sdkMessages.init(SESSION));
    call.emit(sdkMessages.resultError(SESSION, ["Not logged in"]));
    await tick();
    call.fail(new Error("Claude Code returned an error result: Not logged in"));
    expect((await received).map((message) => message.type)).toEqual(["system", "result"]);
    expect(await process.exited()).toEqual({ code: 1, signal: null });

    const broken = driver.launch({ cwd: "/w", prompt: "go" });
    const failing = collect(broken.messages());
    sdk.lastCall().fail(new Error("spawn ENOENT"));
    await expect(failing).rejects.toThrow("spawn ENOENT");
  });

  it("closes the input stream once a Turn ends with a deferred tool", async () => {
    const { driver, sdk } = createDriver();
    const process = driver.launch({ cwd: "/w", prompt: "ask" });
    const received = collect(process.messages());
    const call = sdk.lastCall();
    call.emit(sdkMessages.init(SESSION));
    call.emit(
      sdkMessages.resultSuccess(SESSION, "", {
        stop_reason: "tool_deferred",
        terminal_reason: "tool_deferred",
        deferred_tool_use: { id: "toolu_01", name: ASK_HUMAN_TOOL_NAME, input: { question: "Which colour?" } },
      }),
    );
    await tick();
    expect(call.inputClosed).toBe(true);
    expect(await process.exited()).toEqual({ code: 0, signal: null });
    expect(await received).toHaveLength(2);
  });
});

describe("SdkDriver ask_human hook", () => {
  const launchWith = async (onAskHuman?: (call: AskHumanCall) => Promise<AskHumanDecision>) => {
    const { driver, sdk } = createDriver();
    driver.launch({ cwd: "/w", prompt: "ask", ...(onAskHuman ? { onAskHuman } : {}) });
    const hook = sdk.lastCall().preToolUse();
    return (toolInput: unknown, toolName?: string) => hook(preToolUseInput(toolInput, toolName), "toolu_01", { signal: new AbortController().signal });
  };

  it("defers the call when the Orchestrator has no Answer yet", async () => {
    const seen: AskHumanCall[] = [];
    const run = await launchWith(async (call) => {
      seen.push(call);
      return { kind: "defer" };
    });
    const output = await run({ question: "Which colour?", options: ["red", "blue"] });
    expect(seen).toEqual([{ toolUseId: "toolu_01", question: "Which colour?", options: ["red", "blue"] }]);
    expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } });
  });

  it("allows the same call with the Answer and its source in the updated input", async () => {
    const run = await launchWith(async () => ({ kind: "allow", answer: "blue", source: "alice in issue #7" }));
    expect(await run({ question: "Which colour?", options: ["red", "blue"] })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { question: "Which colour?", options: ["red", "blue"], answer: "blue", source: "alice in issue #7" },
      },
    });
  });

  it("ignores other tools and denies ask_human when the launch has no handler", async () => {
    const run = await launchWith();
    expect(await run({ command: "ls" }, "Bash")).toEqual({});
    expect(await run({ question: "?" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});

describe("SdkDriver history and version", () => {
  it("reads the Session transcript through the SDK and returns user and assistant messages", async () => {
    const entries: SessionMessage[] = [
      { type: "user", uuid: "u1", session_id: SESSION, message: { role: "user", content: "go" }, parent_tool_use_id: null, parent_agent_id: null },
      { type: "system", uuid: "s1", session_id: SESSION, message: { subtype: "compact_boundary" }, parent_tool_use_id: null, parent_agent_id: null },
      {
        type: "assistant",
        uuid: "a1",
        session_id: SESSION,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        parent_tool_use_id: "toolu_09",
        parent_agent_id: null,
      },
    ];
    const requests: unknown[] = [];
    const { driver } = createDriver({}, {
      getSessionMessages: async (sessionId, options) => {
        requests.push([sessionId, options]);
        return entries;
      },
    });

    const history = await driver.getSessionHistory(SESSION, { cwd: "/w" });
    expect(requests).toEqual([[SESSION, { dir: "/w" }]]);
    expect(history).toEqual([
      { type: "user", message: { role: "user", content: "go" }, parent_tool_use_id: null, uuid: "u1", session_id: SESSION },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        parent_tool_use_id: "toolu_09",
        uuid: "a1",
        session_id: SESSION,
      },
    ]);
  });

  it("parses the version from claude --version run with the Agent environment", async () => {
    const execs: unknown[] = [];
    const { driver } = createDriver({}, {
      exec: async (command, args, options) => {
        execs.push([command, args, Object.keys(options.env).sort()]);
        return { stdout: "2.1.318 (Claude Code)\n" };
      },
    });
    expect(await driver.getClaudeVersion()).toBe("2.1.318");
    expect(execs).toEqual([
      ["/usr/local/bin/claude", ["--version"], ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_RETRY_WATCHDOG", "CLAUDE_CONFIG_DIR", "GH_TOKEN", "HOME", "PATH"]],
    ]);
  });
});
