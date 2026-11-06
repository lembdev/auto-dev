import { afterEach, describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { AgentId, IssueNumber, SessionId } from "../../src/ids.js";
import type { AgentHistoryResponse, ServerEvent, TasksResponse } from "../../src/server/app.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";
import { WsClient } from "../helpers/ws-client.js";

const SESSION = "66666666-6666-4666-8666-666666666666" as SessionId;
const ISSUE = 7 as IssueNumber;

type AgentMessageEvent = Extract<ServerEvent, { type: "agent-message" }>;

describe("the Agent panel API: history, live feed, interrupt and cancel", () => {
  let testApp: TestApp;
  let server: RunningServer | undefined;
  let client: WsClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
    await testApp?.orchestrator.shutdown();
    testApp?.close();
  });

  // A Ready issue taken into a Slot: the Implementer process is live and has announced its Session.
  const takeIssue = async () => {
    testApp = createTestApp();
    testApp.ports.github.seedIssue({ number: ISSUE, title: "Seven", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const process = testApp.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));
    await flush();
    return process;
  };

  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

  const connect = async (): Promise<WsClient> => {
    server = await startServer({ app: testApp.app, host: "127.0.0.1", port: 0, log: testApp.log });
    client = await WsClient.connect(`${server.url.replace("http", "ws")}/ws`, { cookie: await testApp.login(), origin: server.url });
    expect(await client.next()).toMatchObject({ type: "hello" });
    return client;
  };

  const nextAgentMessage = async (ws: WsClient): Promise<AgentMessageEvent> => {
    for (let i = 0; i < 20; i += 1) {
      const event = (await ws.next()) as ServerEvent;
      if (event.type === "agent-message") return event;
    }
    throw new Error("no agent-message event");
  };

  const history = async (issue: number = ISSUE): Promise<Response> => testApp.request(`/api/tasks/${issue}/agent/history`);

  it("serves the Session history with a cursor and streams the rest over the subscription without a gap or a repeat", async () => {
    const process = await takeIssue();
    const greeting = sdkMessages.assistantText(SESSION, "Reading the issue.");
    process.emit(greeting);
    process.emit(sdkMessages.messageStart(SESSION, "msg_2"));
    process.emit(sdkMessages.textDelta(SESSION, 0, "Plan: "));
    await flush();
    // The transcript on disk already has the prompt and the greeting, not the streaming tail.
    testApp.ports.driver.histories.set(SESSION, [sdkMessages.userText(SESSION, "Implement issue 7"), greeting]);

    const response = await history();
    expect(response.status).toBe(200);
    const body = (await response.json()) as AgentHistoryResponse;
    expect(body.agent).toMatchObject({ id: 1, role: "implementer", state: "running" });
    expect(body.sessionId).toBe(SESSION);
    expect(body.history.map((message) => message.type)).toEqual(["user", "assistant"]);
    expect(body.cursor).toBe(2);
    expect(testApp.ports.driver.log.of("getSessionHistory")).toEqual([{ method: "getSessionHistory", args: [SESSION, { cwd: "/var/lib/auto-dev/repo/.claude/worktrees/issue-7" }] }]);

    const ws = await connect();
    ws.send({ type: "subscribe", agentId: body.agent.id, after: body.cursor });
    process.emit(sdkMessages.textDelta(SESSION, 0, "write the module."));
    const received = [await nextAgentMessage(ws), await nextAgentMessage(ws), await nextAgentMessage(ws)];
    expect(received.map((event) => [event.agentId, event.seq, event.message.type])).toEqual([
      [1, 3, "stream_event"],
      [1, 4, "stream_event"],
      [1, 5, "stream_event"],
    ]);
    expect(received[2]?.message).toMatchObject({ event: { type: "content_block_delta", delta: { text: "write the module." } } });
  });

  it("sends nothing after unsubscribe and nothing of another Agent", async () => {
    const process = await takeIssue();
    const ws = await connect();
    ws.send({ type: "subscribe", agentId: 1, after: 0 });
    expect((await nextAgentMessage(ws)).message).toMatchObject({ type: "system", subtype: "init" });
    ws.send({ type: "unsubscribe", agentId: 1 });
    await flush();
    process.emit(sdkMessages.assistantText(SESSION, "unseen"));
    await flush();
    testApp.orchestrator.transition(ISSUE, "stuck", "poke");
    const event = (await ws.next()) as ServerEvent;
    expect(event.type).toBe("task");
  });

  it("serves the whole buffered tail when the transcript is empty and the Agent has no Session yet", async () => {
    testApp = createTestApp();
    testApp.ports.github.seedIssue({ number: ISSUE, title: "Seven", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const response = await history();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agent: { id: 1 }, sessionId: null, history: [], cursor: 0 });
    expect(testApp.ports.driver.log.of("getSessionHistory")).toEqual([]);
  });

  it("answers 404 for an unknown Task and for a Task without an Agent", async () => {
    testApp = createTestApp();
    expect((await history(99)).status).toBe(404);
    expect((await testApp.request("/api/tasks/99/agent/interrupt", { method: "POST" })).status).toBe(404);
    expect((await testApp.request("/api/tasks/99/cancel", { method: "POST" })).status).toBe(404);
  });

  it("interrupts a running Turn and keeps the Session; an Agent between Turns answers 409", async () => {
    const process = await takeIssue();
    const interrupted = await testApp.request(`/api/tasks/${ISSUE}/agent/interrupt`, { method: "POST" });
    expect(interrupted.status).toBe(200);
    expect(await interrupted.json()).toEqual({ agent: expect.objectContaining({ id: 1, state: "running" }) });
    expect(process.log.methods()).toEqual(["interrupt"]);
    expect(testApp.index.agents.get(1 as AgentId).sessionId).toBe(SESSION);

    // A deferred ask_human ends the Turn: the Agent waits for an Answer, nothing to interrupt.
    process.emit(
      sdkMessages.resultSuccess(SESSION, "", {
        stop_reason: "tool_deferred",
        terminal_reason: "tool_deferred",
        deferred_tool_use: { id: "toolu_1", name: ASK_HUMAN_TOOL_NAME, input: { question: "Which one?" } },
      }),
    );
    process.end();
    await flush();
    const waiting = await testApp.request(`/api/tasks/${ISSUE}/agent/interrupt`, { method: "POST" });
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toEqual({ error: "the Agent is waiting, not running a Turn" });
    expect(process.log.methods()).toEqual(["interrupt"]);
  });

  it("cancels a Task by closing its issue: the Agent is stopped and the Task leaves the Pipeline at once", async () => {
    const process = await takeIssue();
    const cancelled = await testApp.request(`/api/tasks/${ISSUE}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ issueNumber: ISSUE, stage: "cancelled" });
    expect(testApp.ports.github.log.of("updateIssue")).toEqual([{ method: "updateIssue", args: [ISSUE, { state: "closed", stateReason: "not_planned" }] }]);
    expect(testApp.ports.github.issue(ISSUE)).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(process.log.methods()).toContain("stop");
    expect(testApp.ports.github.pull(1).state).toBe("closed");

    const tasks = (await (await testApp.request("/api/tasks")).json()) as TasksResponse;
    expect(tasks.inProgress).toEqual([]);
    expect(tasks.cancelled).toEqual([expect.objectContaining({ issueNumber: ISSUE, stage: "cancelled", reason: "issue closed without a merged pull request" })]);

    const again = await testApp.request(`/api/tasks/${ISSUE}/cancel`, { method: "POST" });
    expect(again.status).toBe(409);
  });
});
