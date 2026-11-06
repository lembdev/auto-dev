import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import { AgentAlreadyRunningError, AgentNotResumableError, AgentRunner, DEFAULT_IDLE_TIMEOUT_MS } from "../../src/agents/agent-runner.js";
import { FakeClock } from "../../src/fakes/clock.js";
import { FakeDriverPort } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { AgentId, IssueNumber, SessionId, ToolUseId } from "../../src/ids.js";
import type { AgentState } from "../../src/index/agents.js";
import { IN_MEMORY, openRuntimeIndex, type RuntimeIndex } from "../../src/index/runtime-index.js";
import { createLogger } from "../../src/log.js";

const SESSION = "33333333-3333-4333-8333-333333333333" as SessionId;
const ISSUE = 7 as IssueNumber;
const WORKTREE = "/repo/.claude/worktrees/issue-7";
const MINUTE = 60_000;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const deferredResult = (sessionId: SessionId) =>
  sdkMessages.resultSuccess(sessionId, "", {
    stop_reason: "tool_deferred",
    terminal_reason: "tool_deferred",
    deferred_tool_use: { id: "toolu_01", name: ASK_HUMAN_TOOL_NAME, input: { question: "Which colour?" } },
  });

describe("AgentRunner", () => {
  const indexes: RuntimeIndex[] = [];

  const setup = () => {
    const driver = new FakeDriverPort();
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const index = openRuntimeIndex(IN_MEMORY);
    indexes.push(index);
    const transitions: AgentState[] = [];
    const runner = new AgentRunner({ driver, clock, agents: index.agents, log: createLogger({ level: "silent" }) });
    runner.onStateChange((agent) => transitions.push(agent.state));
    const startImplementer = () => runner.start({ issueNumber: ISSUE, role: "implementer", cwd: WORKTREE, prompt: "implement #7" });
    return { driver, clock, index, runner, transitions, startImplementer };
  };

  afterEach(() => {
    for (const index of indexes.splice(0)) index.close();
  });

  it("launches the Agent in its worktree and records it as running with pid and session id", async () => {
    const { driver, index, runner, startImplementer } = setup();
    const agent = startImplementer();

    expect(driver.calls).toEqual([{ method: "launch", args: [{ cwd: WORKTREE, prompt: "implement #7" }] }]);
    expect(agent).toMatchObject({ issueNumber: ISSUE, role: "implementer", cwd: WORKTREE, state: "running", pid: 1000, sessionId: null });

    driver.lastLaunch().emit(sdkMessages.init(SESSION));
    await flush();
    expect(index.agents.get(agent.id)).toMatchObject({ state: "running", sessionId: SESSION, pid: 1000 });
    expect(runner.isLive(agent.id)).toBe(true);
  });

  it("goes idle after a Turn and stops the process when the idle timeout passes", async () => {
    const { driver, clock, index, runner, transitions, startImplementer } = setup();
    const agent = startImplementer();
    const fake = driver.lastLaunch();
    fake.emit(sdkMessages.init(SESSION));
    fake.emit(sdkMessages.assistantText(SESSION, "done"));
    await clock.advance(2 * MINUTE);
    fake.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();

    expect(index.agents.get(agent.id)).toMatchObject({ state: "idle", pid: 1000, lastTurnAt: new Date(clock.now()).toISOString() });

    await clock.advance(DEFAULT_IDLE_TIMEOUT_MS - 1);
    expect(fake.log.methods()).toEqual([]);
    expect(index.agents.get(agent.id).state).toBe("idle");

    await clock.advance(1);
    await flush();
    expect(fake.log.methods()).toEqual(["stop"]);
    expect(index.agents.get(agent.id)).toMatchObject({ state: "stopped", pid: null, sessionId: SESSION });
    expect(runner.isLive(agent.id)).toBe(false);
    expect(transitions).toEqual(["running", "idle", "stopped"]);
  });

  it("starts a new Turn on send and cancels the idle timeout", async () => {
    const { driver, clock, index, runner, startImplementer } = setup();
    const agent = startImplementer();
    const fake = driver.lastLaunch();
    fake.emit(sdkMessages.init(SESSION));
    fake.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();

    await clock.advance(5 * MINUTE);
    await runner.send(agent.id, "also add tests");
    expect(fake.sent).toEqual(["also add tests"]);
    expect(index.agents.get(agent.id).state).toBe("running");

    await clock.advance(DEFAULT_IDLE_TIMEOUT_MS);
    expect(fake.log.methods()).toEqual(["send"]);
    expect(index.agents.get(agent.id).state).toBe("running");

    fake.emit(sdkMessages.resultSuccess(SESSION, "tests added"));
    await flush();
    expect(index.agents.get(agent.id).state).toBe("idle");
    await clock.advance(DEFAULT_IDLE_TIMEOUT_MS);
    await flush();
    expect(fake.log.methods()).toEqual(["send", "stop"]);
    expect(index.agents.get(agent.id).state).toBe("stopped");
  });

  it("leaves the Agent waiting after a deferred ask_human and does not touch it on idle timeout", async () => {
    const { driver, clock, index, runner, transitions, startImplementer } = setup();
    const agent = startImplementer();
    const fake = driver.lastLaunch();
    fake.emit(sdkMessages.init(SESSION));
    fake.emit(deferredResult(SESSION));
    fake.end();
    await flush();

    expect(index.agents.get(agent.id)).toMatchObject({ state: "waiting", pid: null, sessionId: SESSION });
    expect(runner.isLive(agent.id)).toBe(false);
    await clock.advance(DEFAULT_IDLE_TIMEOUT_MS);
    expect(fake.log.methods()).toEqual([]);
    expect(index.agents.get(agent.id).state).toBe("waiting");
    expect(transitions).toEqual(["running", "waiting"]);
    await expect(runner.send(agent.id, "hello")).rejects.toThrow(AgentNotResumableError);
  });

  it("resumes a waiting Session with an open stream and the ask_human handler", async () => {
    const { driver, index, runner, startImplementer } = setup();
    const agent = startImplementer();
    const first = driver.lastLaunch();
    first.emit(sdkMessages.init(SESSION));
    first.emit(deferredResult(SESSION));
    first.end();
    await flush();

    const onAskHuman = async () => ({ kind: "allow" as const, answer: "blue", source: "alice" });
    const resumed = runner.resume(agent.id, { onAskHuman, resumeInterruptedTurn: true });
    expect(resumed).toMatchObject({ id: agent.id, state: "running", pid: 1001, sessionId: SESSION });
    const second = driver.lastLaunch();
    expect(second.launch).toEqual({ cwd: WORKTREE, resume: SESSION, resumeInterruptedTurn: true, onAskHuman });
    expect(await second.askHuman({ toolUseId: "toolu_01" as ToolUseId, question: "Which colour?", options: undefined })).toEqual({
      kind: "allow",
      answer: "blue",
      source: "alice",
    });

    second.emit(sdkMessages.resultSuccess(SESSION, "blue"));
    await flush();
    expect(index.agents.get(agent.id).state).toBe("idle");
    expect(index.agents.list()).toHaveLength(1);
  });

  it("resumes a stopped Session with the next message as the prompt, keeping the launch options", async () => {
    const { driver, clock, runner } = setup();
    const onAskHuman = async () => ({ kind: "defer" as const });
    const agent = runner.start({ issueNumber: ISSUE, role: "qa", cwd: WORKTREE, prompt: "review", env: { AUTO_DEV_ROLE: "qa" }, onAskHuman });
    const first = driver.lastLaunch();
    first.emit(sdkMessages.init(SESSION));
    first.emit(sdkMessages.resultSuccess(SESSION, "verdict"));
    await flush();
    await clock.advance(DEFAULT_IDLE_TIMEOUT_MS);
    await flush();
    expect(runner.isLive(agent.id)).toBe(false);

    await runner.send(agent.id, "round 2");
    expect(driver.lastLaunch().launch).toEqual({ cwd: WORKTREE, resume: SESSION, prompt: "round 2", env: { AUTO_DEV_ROLE: "qa" }, onAskHuman });
    expect(runner.find(agent.id)).toMatchObject({ state: "running", pid: 1001 });
  });

  it("refuses to resume without a session id or while a process is live", async () => {
    const { runner, startImplementer } = setup();
    const agent = startImplementer();
    expect(() => runner.resume(agent.id)).toThrow(AgentAlreadyRunningError);
    const fresh = runner.start({ role: "planner", cwd: "/repo", prompt: "plan" });
    await runner.stop(fresh.id);
    expect(() => runner.resume(fresh.id)).toThrow(AgentNotResumableError);
    expect(() => runner.resume(999 as AgentId)).toThrow("not found");
  });

  it("stops a running Agent on request and after an unexpected exit", async () => {
    const { driver, index, runner, transitions, startImplementer } = setup();
    const agent = startImplementer();
    const fake = driver.lastLaunch();
    fake.emit(sdkMessages.init(SESSION));
    await runner.stop(agent.id);
    expect(fake.log.methods()).toEqual(["stop"]);
    expect(index.agents.get(agent.id)).toMatchObject({ state: "stopped", pid: null });

    const crashed = startImplementer();
    driver.lastLaunch().end({ code: 1, signal: null });
    await flush();
    expect(index.agents.get(crashed.id)).toMatchObject({ state: "stopped", pid: null });
    expect(transitions).toEqual(["running", "stopped", "running", "stopped"]);
  });

  it("forwards every SDK message with the current Agent record", async () => {
    const { driver, runner, startImplementer } = setup();
    const seen: [AgentId, AgentState, SDKMessage["type"]][] = [];
    runner.onMessage((agent, message) => seen.push([agent.id, agent.state, message.type]));
    const agent = startImplementer();
    const fake = driver.lastLaunch();
    fake.emit(sdkMessages.init(SESSION));
    fake.emit(sdkMessages.resultSuccess(SESSION, "ok"));
    await flush();
    expect(seen).toEqual([
      [agent.id, "running", "system"],
      [agent.id, "idle", "result"],
    ]);
  });

  it("shuts every live process down", async () => {
    const { driver, runner, startImplementer } = setup();
    startImplementer();
    runner.start({ role: "planner", cwd: "/repo", prompt: "plan" });
    await runner.shutdown();
    expect(runner.liveIds()).toEqual([]);
    expect(driver.launches.map((launch) => launch.log.methods())).toEqual([["stop"], ["stop"]]);
  });
});

describe("AgentRunner.restartAfterTurn", () => {
  const indexes: RuntimeIndex[] = [];
  afterEach(() => {
    for (const index of indexes.splice(0)) index.close();
  });

  const setup = () => {
    const driver = new FakeDriverPort();
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const index = openRuntimeIndex(IN_MEMORY);
    indexes.push(index);
    const runner = new AgentRunner({ driver, clock, agents: index.agents, log: createLogger({ level: "silent" }) });
    return { driver, clock, index, runner };
  };

  it("stops an idle Agent at once and a running one when its Turn ends; the next message resumes the Session", async () => {
    const { driver, index, runner } = setup();
    const idle = runner.start({ issueNumber: 7 as IssueNumber, role: "implementer", cwd: WORKTREE, prompt: "implement #7" });
    const idleProcess = driver.lastLaunch();
    idleProcess.emit(sdkMessages.init(SESSION));
    idleProcess.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();
    const busySession = "44444444-4444-4444-8444-444444444444" as SessionId;
    const busy = runner.start({ issueNumber: 8 as IssueNumber, role: "qa", cwd: "/repo/.claude/worktrees/issue-8", prompt: "review #8" });
    const busyProcess = driver.lastLaunch();
    busyProcess.emit(sdkMessages.init(busySession));
    await flush();
    expect(index.agents.get(idle.id).state).toBe("idle");
    expect(index.agents.get(busy.id).state).toBe("running");

    await runner.restartAfterTurn("secrets changed");
    await flush();
    expect(idleProcess.calls.map((call) => call.method)).toContain("stop");
    expect(index.agents.get(idle.id)).toMatchObject({ state: "stopped", pid: null, sessionId: SESSION });
    expect(busyProcess.calls.map((call) => call.method)).not.toContain("stop");
    expect(index.agents.get(busy.id).state).toBe("running");

    busyProcess.emit(sdkMessages.assistantText(busySession, "verdict"));
    busyProcess.emit(sdkMessages.resultSuccess(busySession, "verdict"));
    await flush();
    await flush();
    expect(busyProcess.calls.map((call) => call.method)).toContain("stop");
    expect(index.agents.get(busy.id)).toMatchObject({ state: "stopped", pid: null, sessionId: busySession });

    await runner.send(idle.id, "blockers: fix the test");
    expect(driver.lastLaunch().launch).toMatchObject({ cwd: WORKTREE, resume: SESSION, prompt: "blockers: fix the test" });
    expect(index.agents.get(idle.id).state).toBe("running");
  });

  it("leaves a waiting Agent alone", async () => {
    const { driver, index, runner } = setup();
    const agent = runner.start({ issueNumber: 7 as IssueNumber, role: "implementer", cwd: WORKTREE, prompt: "implement #7", onAskHuman: async () => ({ kind: "defer" }) });
    const fake = driver.lastLaunch();
    fake.emit(sdkMessages.init(SESSION));
    fake.emit(deferredResult(SESSION));
    fake.end();
    await flush();
    expect(index.agents.get(agent.id).state).toBe("waiting");
    await runner.restartAfterTurn("secrets changed");
    expect(index.agents.get(agent.id).state).toBe("waiting");
    expect(driver.launches).toHaveLength(1);
  });
});
