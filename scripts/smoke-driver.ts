// Manual smoke of the real Driver under a Claude Max login. Not part of CI: it starts the system `claude`.
//
//   npx tsx scripts/smoke-driver.ts start                      # prompt, follow-up message, stop
//   npx tsx scripts/smoke-driver.ts ask                        # ask_human gets deferred; prints the session id
//   npx tsx scripts/smoke-driver.ts resume <sessionId> <answer> # open stream, hook allows with the Answer
//   npx tsx scripts/smoke-driver.ts interrupt                  # stop() mid-Turn: interrupt, then SIGTERM
//   npx tsx scripts/smoke-driver.ts idle                       # AgentRunner stops the process after the idle timeout
//
// Env: AUTO_DEV_SMOKE_MODEL (default haiku), AUTO_DEV_SMOKE_IDLE_MS (default 5000), AUTO_DEV_SMOKE_CWD (default a temp dir),
// CLAUDE_CONFIG_DIR / CLAUDE_CODE_OAUTH_TOKEN / GH_TOKEN as for the Installation. A macOS Keychain login works without
// a token but needs USER in the Agent environment and no explicit CLAUDE_CONFIG_DIR (the Keychain entry is keyed by it),
// so AUTO_DEV_SMOKE_EXTRA_ENV (comma-separated names, default USER) is copied from this process into every launch and
// CLAUDE_CONFIG_DIR is passed only when set here.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEnvSource } from "../src/adapters/agent-env.js";
import { SdkDriver } from "../src/adapters/driver.js";
import { askHumanServerArgs, SystemClock } from "../src/adapters/index.js";
import { AgentRunner } from "../src/agents/agent-runner.js";
import type { SessionId } from "../src/ids.js";
import { IN_MEMORY, openRuntimeIndex } from "../src/index/runtime-index.js";
import { createLogger } from "../src/log.js";
import type { AgentProcess } from "../src/ports/driver.js";

const [mode = "start", sessionArg, answerArg] = process.argv.slice(2);
const model = process.env.AUTO_DEV_SMOKE_MODEL ?? "haiku";
const idleMs = Number(process.env.AUTO_DEV_SMOKE_IDLE_MS ?? 5_000);
const cwd = process.env.AUTO_DEV_SMOKE_CWD ?? mkdtempSync(path.join(os.tmpdir(), "auto-dev-smoke-"));
const log = createLogger({ level: (process.env.LOG_LEVEL as "info" | "debug" | undefined) ?? "info" });
const extraEnv = Object.fromEntries(
  (process.env.AUTO_DEV_SMOKE_EXTRA_ENV ?? "USER")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && process.env[name] !== undefined)
    .map((name) => [name, process.env[name] as string]),
);

const say = (line: string) => process.stdout.write(`${line}\n`);

const brief = (message: SDKMessage): string => {
  switch (message.type) {
    case "system":
      return message.subtype === "init"
        ? `init session=${message.session_id} model=${message.model} tools=${message.tools.filter((t) => t.startsWith("mcp__")).join(",")} mcp=${JSON.stringify(message.mcp_servers)}`
        : `system/${message.subtype}`;
    case "assistant":
      return `assistant ${message.message.content.map((block) => (block.type === "text" ? JSON.stringify(block.text) : block.type === "tool_use" ? `tool_use ${block.name} ${JSON.stringify(block.input)}` : block.type)).join(" | ")}`;
    case "user":
      return `user ${typeof message.message.content === "string" ? JSON.stringify(message.message.content) : message.message.content.map((block) => block.type).join(",")}`;
    case "result":
      return `result ${message.subtype} stop=${message.stop_reason ?? "null"} terminal=${message.terminal_reason ?? "-"} is_error=${message.is_error}${"result" in message ? ` text=${JSON.stringify(message.result)}` : ""}${"deferred_tool_use" in message && message.deferred_tool_use ? ` deferred=${JSON.stringify(message.deferred_tool_use)}` : ""}`;
    case "stream_event":
      return "";
    default:
      return message.type;
  }
};

const envSource: AgentEnvSource = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"] as const) {
  if (process.env[key]) envSource[key] = process.env[key];
}

const driver = new SdkDriver({ envSource, askHumanServerArgs: askHumanServerArgs(), log });

async function watch(agent: AgentProcess, onMessage?: (message: SDKMessage) => void | Promise<void>): Promise<void> {
  for await (const message of agent.messages()) {
    const line = brief(message);
    if (line) say(`  ${line}`);
    await onMessage?.(message);
  }
  say(`  exited ${JSON.stringify(await agent.exited())}`);
}

const isResult = (message: SDKMessage) => message.type === "result";

async function start(): Promise<void> {
  say(`claude ${await driver.getClaudeVersion()} at ${driver.claudePath()}, cwd ${cwd}`);
  const agent = driver.launch({ cwd, model, env: extraEnv, prompt: "Reply with exactly one word: OK" });
  say(`launched pid=${agent.pid()}`);
  let turn = 0;
  await watch(agent, async (message) => {
    if (!isResult(message)) return;
    turn++;
    if (turn === 1) {
      say(`  session=${agent.sessionId()}; sending a follow-up into the live stream`);
      await agent.send("Now reply with exactly one word: DONE");
    } else {
      say("  stopping the idle process");
      await agent.stop();
    }
  });
}

async function ask(): Promise<void> {
  const agent = driver.launch({
    cwd,
    model,
    env: extraEnv,
    prompt: "Use the ask_human tool to ask me which colour I prefer (options: red, blue). Then answer with exactly one word: the colour I chose.",
    onAskHuman: async (call) => {
      say(`  hook: ask_human ${JSON.stringify(call)} -> defer`);
      return { kind: "defer" };
    },
  });
  await watch(agent);
  say(`resume with: npx tsx scripts/smoke-driver.ts resume ${agent.sessionId()} blue`);
}

async function resume(): Promise<void> {
  if (!sessionArg) throw new Error("usage: resume <sessionId> <answer>");
  const agent = driver.launch({
    cwd,
    model,
    env: extraEnv,
    resume: sessionArg as SessionId,
    onAskHuman: async (call) => {
      say(`  hook: ask_human ${JSON.stringify(call)} -> allow "${answerArg ?? "blue"}"`);
      return { kind: "allow", answer: answerArg ?? "blue", source: "smoke script" };
    },
  });
  await watch(agent, async (message) => {
    if (isResult(message)) await agent.stop();
  });
}

async function interrupt(): Promise<void> {
  const agent = driver.launch({ cwd, model, env: extraEnv, prompt: "Run the Bash command `sleep 60 && echo done` and then reply with exactly: DONE" });
  let stopped = false;
  await watch(agent, async (message) => {
    if (stopped || message.type !== "assistant" || !message.message.content.some((block) => block.type === "tool_use")) return;
    stopped = true;
    say(`  tool_use seen, stopping pid=${agent.pid()} (interrupt, then SIGTERM if needed)`);
    const started = Date.now();
    const exit = await agent.stop();
    say(`  stop() -> ${JSON.stringify(exit)} after ${Date.now() - started} ms`);
  });
}

async function idle(): Promise<void> {
  const index = openRuntimeIndex(IN_MEMORY);
  const runner = new AgentRunner({ driver, clock: new SystemClock(), agents: index.agents, log, idleTimeoutMs: idleMs });
  runner.onStateChange((agent, previous) => say(`  state ${previous} -> ${agent.state} pid=${agent.pid} session=${agent.sessionId} lastTurnAt=${agent.lastTurnAt}`));
  runner.onMessage((_agent, message) => {
    const line = brief(message);
    if (line) say(`  ${line}`);
  });
  const stopped = new Promise<void>((resolve) => {
    runner.onStateChange((agent) => {
      if (agent.state === "stopped") resolve();
    });
  });
  const agent = runner.start({ role: "planner", cwd, prompt: "Reply with exactly one word: OK", env: extraEnv, model });
  say(`agent ${agent.id} started, idle timeout ${idleMs} ms`);
  await stopped;
  say(`  final row ${JSON.stringify(index.agents.get(agent.id))}`);
  index.close();
}

const modes: Record<string, () => Promise<void>> = { start, ask, resume, interrupt, idle };
const run = modes[mode];
if (!run) {
  say(`unknown mode "${mode}"; one of ${Object.keys(modes).join(", ")}`);
  process.exit(2);
}
run().catch((error: unknown) => {
  say(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
