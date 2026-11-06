import { afterEach, describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId, ToolUseId } from "../../src/ids.js";
import { isMarkedComment } from "../../src/orchestrator/comments.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { AskHumanCall } from "../../src/ports/driver.js";
import type { DialogueResponse, ServerEvent } from "../../src/server/app.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";
import { WsClient } from "../helpers/ws-client.js";

const SESSION = "77777777-7777-4777-8777-777777777777" as SessionId;
const ISSUE = 42 as IssueNumber;
const CALL: AskHumanCall = { toolUseId: "toolu_42" as ToolUseId, question: "Which colour for the button?", options: ["red", "blue"] };
const TAB = "tab-a";

type Ack = Extract<ServerEvent, { type: "ack" }>;

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const deferredResult = (call: AskHumanCall) =>
  sdkMessages.resultSuccess(SESSION, "", {
    stop_reason: "tool_deferred",
    terminal_reason: "tool_deferred",
    deferred_tool_use: { id: call.toolUseId, name: ASK_HUMAN_TOOL_NAME, input: { question: call.question, options: call.options } },
  });

describe("the Dialogue and the Answer from the UI", () => {
  let testApp: TestApp;
  let server: RunningServer | undefined;
  const clients: WsClient[] = [];
  const restarted: Orchestrator[] = [];

  afterEach(async () => {
    skipped.splice(0);
    for (const client of clients.splice(0)) await client.close();
    await server?.close();
    server = undefined;
    for (const orchestrator of restarted.splice(0)) await orchestrator.shutdown();
    await testApp?.orchestrator.shutdown();
    testApp?.close();
  });

  // A Ready issue taken into a Slot: the Implementer is running its first Turn.
  const takeIssue = async (): Promise<FakeAgentProcess> => {
    testApp = createTestApp();
    testApp.ports.github.seedIssue({ number: ISSUE, title: "Forty-two", body: "Build it.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const process = testApp.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));
    await flush();
    return process;
  };

  // The Implementer asked a question and was deferred: the Agent waits, the Request is in the issue.
  const waiting = async (): Promise<FakeAgentProcess> => {
    const first = await takeIssue();
    expect(await first.askHuman(CALL)).toEqual({ kind: "defer" });
    first.emit(deferredResult(CALL));
    first.end();
    await flush();
    expect(testApp.index.humanRequests.listOpen()).toHaveLength(1);
    return first;
  };

  const connect = async (): Promise<WsClient> => {
    server ??= await startServer({ app: testApp.app, host: "127.0.0.1", port: 0, log: testApp.log });
    const client = await WsClient.connect(`${server.url.replace("http", "ws")}/ws`, { cookie: await testApp.login(), origin: server.url });
    clients.push(client);
    expect(await client.next()).toMatchObject({ type: "hello" });
    return client;
  };

  // Events read past while waiting for another type; a later wait finds them here first.
  const skipped: ServerEvent[] = [];

  const until = async <T extends ServerEvent["type"]>(ws: WsClient, type: T): Promise<Extract<ServerEvent, { type: T }>> => {
    const earlier = skipped.findIndex((event) => event.type === type);
    if (earlier >= 0) return skipped.splice(earlier, 1)[0] as Extract<ServerEvent, { type: T }>;
    for (let i = 0; i < 30; i += 1) {
      const event = (await ws.next()) as ServerEvent;
      if (event.type === type) return event as Extract<ServerEvent, { type: T }>;
      skipped.push(event);
    }
    throw new Error(`no ${type} event`);
  };

  const ack = async (ws: WsClient, frame: Record<string, unknown>): Promise<Ack> => {
    ws.send(frame);
    return until(ws, "ack");
  };

  const answerFrame = (seq: number, text: string, requestId = 1) => ({ type: "answer", clientId: TAB, seq, requestId, text });
  const dialogueFrame = (seq: number, text: string, issueNumber: number = ISSUE) => ({ type: "dialogue", clientId: TAB, seq, issueNumber, text });

  const queue = async (issue: number = ISSUE): Promise<DialogueResponse["messages"]> => {
    const response = await testApp.request(`/api/tasks/${issue}/dialogue`);
    expect(response.status).toBe(200);
    return ((await response.json()) as DialogueResponse).messages;
  };

  const resumes = () => testApp.ports.driver.launches.filter((launch) => launch.launch.resume === SESSION);

  it("delivers an Answer from the UI through resume, mirrors it as a marked comment and applies it once", async () => {
    await waiting();
    const ws = await connect();
    expect(await ack(ws, answerFrame(1, "blue"))).toEqual({ type: "ack", clientId: TAB, seq: 1, watermark: 1, outcome: "applied", reason: null });
    await flush();

    const { github, driver } = testApp.ports;
    expect(resumes()).toHaveLength(1);
    const resumed = driver.lastLaunch();
    expect(resumed.launch.prompt).toBeUndefined();
    const decision = await resumed.askHuman(CALL);
    expect(decision).toMatchObject({ kind: "allow", answer: "blue" });
    expect(decision.kind === "allow" ? decision.source : "").toContain("UI");

    const comments = github.commentsOf(ISSUE);
    expect(comments).toHaveLength(2);
    expect(isMarkedComment(comments[1]!.body)).toBe(true);
    expect(comments[1]!.body).toContain("Ответ из UI");
    expect(comments[1]!.body).toContain("blue");
    expect(github.reactions).toEqual([]);
    expect(testApp.index.appliedAnswers.find({ kind: "ui", id: `${TAB}:1` })).toMatchObject({ requestId: 1 });
    expect(testApp.index.humanRequests.listOpen()).toEqual([]);
    expect(await queue()).toEqual([]);

    // The same frame again (the ACK was lost): confirmed, not applied again.
    expect(await ack(ws, answerFrame(1, "blue"))).toMatchObject({ seq: 1, watermark: 1, outcome: "duplicate" });
    await testApp.orchestrator.pollOnce();
    expect(resumes()).toHaveLength(1);
    expect(github.commentsOf(ISSUE)).toHaveLength(2);
  });

  it("refuses an Answer from the UI once GitHub answered first and queues its text as a line of the Dialogue", async () => {
    await waiting();
    const { github, driver } = testApp.ports;
    github.humanComment(ISSUE, "red");
    await testApp.orchestrator.pollOnce();
    const resumed = driver.lastLaunch();
    const ws = await connect();

    const refused = await ack(ws, answerFrame(1, "blue"));
    expect(refused).toMatchObject({ outcome: "rejected", watermark: 1 });
    expect(refused.reason).toContain("already answered");
    expect(await until(ws, "dialogue")).toEqual({ type: "dialogue", issueNumber: ISSUE, messageId: 1, state: "queued" });
    expect(await queue()).toEqual([expect.objectContaining({ id: 1, source: "ui", clientId: TAB, seq: 1, text: "blue" })]);
    expect(await resumed.askHuman(CALL)).toMatchObject({ kind: "allow", answer: "red" });
    expect(resumed.sent).toEqual([]);

    resumed.emit(sdkMessages.init(SESSION));
    resumed.emit(sdkMessages.resultSuccess(SESSION, "red it is"));
    await flush();
    expect(resumed.sent).toEqual(["blue"]);
    expect(await until(ws, "dialogue")).toEqual({ type: "dialogue", issueNumber: ISSUE, messageId: 1, state: "delivered" });
    expect(await queue()).toEqual([]);
    expect(github.commentsOf(ISSUE).filter((comment) => comment.body.includes("Ответ из UI"))).toEqual([]);
  });

  it("treats a GitHub comment after an Answer from the UI as a line of the Dialogue, not as an Answer", async () => {
    await waiting();
    const ws = await connect();
    expect(await ack(ws, answerFrame(1, "blue"))).toMatchObject({ outcome: "applied" });
    await flush();
    const { github, driver } = testApp.ports;
    const resumed = driver.lastLaunch();
    expect(await resumed.askHuman(CALL)).toMatchObject({ kind: "allow", answer: "blue" });

    const other = github.seedIssue({ number: 43, title: "Other" });
    github.humanComment(other.number, "unrelated");
    const line = github.humanComment(ISSUE, "also check the footer", "bob");
    await testApp.orchestrator.pollOnce();
    expect(github.reactions).toEqual([]);
    expect(resumes()).toHaveLength(1);
    const queued = await queue();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ source: "github", clientId: "github", seq: line.id });
    expect(queued[0]!.text).toContain("also check the footer");
    expect(queued[0]!.text).toContain("bob");

    // An edit of the comment shows up in the poll again; the line is queued once.
    await testApp.ports.clock.advance(1_000);
    github.humanEditComment(line.id, "also check the footer, please");
    await testApp.orchestrator.pollOnce();
    expect(await queue()).toHaveLength(1);

    resumed.emit(sdkMessages.init(SESSION));
    resumed.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();
    expect(resumed.sent).toHaveLength(1);
    expect(resumed.sent[0]).toContain("also check the footer");
    expect(resumed.sent[0]).toContain(line.htmlUrl);
    expect(await queue()).toEqual([]);
  });

  it("queues lines typed during a Turn, lets the human take one back and delivers the rest once the Turn is over", async () => {
    const process = await takeIssue();
    const ws = await connect();
    expect(await ack(ws, dialogueFrame(1, "first"))).toEqual({ type: "ack", clientId: TAB, seq: 1, watermark: 1, outcome: "applied", reason: null });
    expect(await until(ws, "dialogue")).toEqual({ type: "dialogue", issueNumber: ISSUE, messageId: 1, state: "queued" });
    expect(await ack(ws, dialogueFrame(2, "second"))).toMatchObject({ seq: 2, watermark: 2, outcome: "applied" });
    expect(await until(ws, "dialogue")).toEqual({ type: "dialogue", issueNumber: ISSUE, messageId: 2, state: "queued" });
    expect(await queue()).toEqual([
      expect.objectContaining({ id: 1, issueNumber: ISSUE, agentId: 1, source: "ui", text: "first" }),
      expect.objectContaining({ id: 2, text: "second" }),
    ]);
    expect(process.sent).toEqual([]);

    const removed = await testApp.request(`/api/tasks/${ISSUE}/dialogue/1`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ id: 1 });
    expect(await until(ws, "dialogue")).toEqual({ type: "dialogue", issueNumber: ISSUE, messageId: 1, state: "removed" });
    expect(await queue()).toEqual([expect.objectContaining({ id: 2 })]);
    expect((await testApp.request(`/api/tasks/${ISSUE}/dialogue/1`, { method: "DELETE" })).status).toBe(404);

    process.emit(sdkMessages.resultSuccess(SESSION, "turn done"));
    await flush();
    expect(process.sent).toEqual(["second"]);
    expect(await queue()).toEqual([]);
    // The QA round that started at the end of the Turn is void: the Implementer works on the line.
    expect(testApp.index.tasks.get(ISSUE).stage).toBe("implement");
    expect(testApp.index.agents.listByIssue(ISSUE).map((agent) => [agent.role, agent.state])).toEqual([
      ["implementer", "running"],
      ["qa", "stopped"],
    ]);
    expect((await testApp.request(`/api/tasks/${ISSUE}/dialogue/2`, { method: "DELETE" })).status).toBe(409);
    expect((await testApp.request("/api/tasks/99/dialogue")).status).toBe(404);
  });

  it("delivers a line to an idle Agent at once and resumes a stopped one with the line as the prompt", async () => {
    const process = await takeIssue();
    // A failed Turn leaves the Implementer idle and the Task in its Stage: nobody else is working on it.
    process.emit(sdkMessages.resultError(SESSION, ["context overflow"]));
    await flush();
    expect(testApp.index.agents.listByIssue(ISSUE)).toMatchObject([{ state: "idle" }]);
    const ws = await connect();
    expect(await ack(ws, dialogueFrame(1, "now"))).toMatchObject({ outcome: "applied" });
    await flush();
    expect(process.sent).toEqual(["now"]);

    process.end();
    await flush();
    expect(testApp.index.agents.listByIssue(ISSUE)[0]?.state).toBe("stopped");
    expect(await ack(ws, dialogueFrame(2, "later"))).toMatchObject({ outcome: "applied" });
    await flush();
    expect(resumes()).toHaveLength(1);
    const resumed = testApp.ports.driver.lastLaunch();
    expect(resumed.launch).toMatchObject({ resume: SESSION, prompt: "later" });
    expect(resumed.launch.onAskHuman).toBeDefined();
    expect(await queue()).toEqual([]);
  });

  it("refuses an empty line, a line to an unknown Task and a broken frame for good; a repeat of any frame is a duplicate", async () => {
    await takeIssue();
    const ws = await connect();
    expect(await ack(ws, dialogueFrame(1, "   "))).toEqual({ type: "ack", clientId: TAB, seq: 1, watermark: 1, outcome: "rejected", reason: "empty text" });
    expect(await ack(ws, dialogueFrame(2, "hello", 99))).toMatchObject({ seq: 2, watermark: 2, outcome: "rejected" });
    expect(await ack(ws, dialogueFrame(2, "hello", 99))).toMatchObject({ seq: 2, watermark: 2, outcome: "duplicate" });
    expect(await ack(ws, answerFrame(3, "blue", 77))).toMatchObject({ seq: 3, watermark: 3, outcome: "rejected", reason: "unknown request" });
    const broken = await ack(ws, { type: "dialogue", clientId: TAB, seq: 4, issueNumber: "forty-two", text: "hi" });
    expect(broken).toMatchObject({ seq: 4, watermark: 3, outcome: "rejected" });
    expect(broken.reason).toContain("issueNumber");
    expect(await ack(ws, dialogueFrame(1, "late"))).toMatchObject({ seq: 1, watermark: 3, outcome: "duplicate" });
    expect(await queue()).toEqual([]);
  });

  it("confirms a frame sent again after a reconnect without applying it twice and tells the client its watermark", async () => {
    await takeIssue();
    const first = await connect();
    expect(await ack(first, dialogueFrame(1, "one"))).toMatchObject({ outcome: "applied", watermark: 1 });
    expect(await ack(first, dialogueFrame(5, "five"))).toMatchObject({ outcome: "applied", watermark: 5 });
    await first.close();
    clients.splice(clients.indexOf(first), 1);

    const second = await connect();
    expect(await ack(second, dialogueFrame(1, "one"))).toEqual({ type: "ack", clientId: TAB, seq: 1, watermark: 5, outcome: "duplicate", reason: null });
    expect(await ack(second, dialogueFrame(5, "five"))).toMatchObject({ seq: 5, outcome: "duplicate", watermark: 5 });
    // A tab whose counter fell behind the watermark learns it from the ACK; its frame is not applied.
    expect(await ack(second, dialogueFrame(3, "three"))).toMatchObject({ seq: 3, outcome: "duplicate", watermark: 5 });
    expect(await ack(second, dialogueFrame(6, "six"))).toMatchObject({ seq: 6, outcome: "applied", watermark: 6 });
    expect((await queue()).map((message) => message.text)).toEqual(["one", "five", "six"]);
  });

  it("delivers an Answer from the UI that was accepted before a restart: the row survives in the index", async () => {
    await waiting();
    const { github, driver } = testApp.ports;
    const launch = driver.launch.bind(driver);
    driver.launch = () => {
      throw new Error("claude not found");
    };
    const ws = await connect();
    expect(await ack(ws, answerFrame(1, "blue"))).toMatchObject({ outcome: "applied" });
    await flush();
    expect(github.commentsOf(ISSUE)).toHaveLength(2);
    await testApp.orchestrator.shutdown();
    driver.launch = launch;

    const orchestrator = new Orchestrator({ ports: testApp.ports, index: testApp.index, log: testApp.log, product: { repoPath: TEST_REPO_PATH } });
    restarted.push(orchestrator);
    await orchestrator.pollOnce();
    expect(resumes()).toHaveLength(1);
    const resumed = driver.lastLaunch();
    const decision = await resumed.askHuman(CALL);
    expect(decision).toMatchObject({ kind: "allow", answer: "blue" });
    expect(decision.kind === "allow" ? decision.source : "").toContain("UI");
    expect(github.commentsOf(ISSUE)).toHaveLength(2);
    expect(testApp.index.appliedAnswers.find({ kind: "ui", id: `${TAB}:1` })).toBeDefined();
    expect(await orchestrator.dialogue.receive({ type: "answer", clientId: TAB, seq: 1, requestId: 1 as never, text: "blue" })).toMatchObject({ outcome: "duplicate", watermark: 1 });
  });

  it("delivers a line queued during a Turn after a restart, once the resumed Turn is over", async () => {
    await takeIssue();
    const ws = await connect();
    expect(await ack(ws, dialogueFrame(1, "after the restart"))).toMatchObject({ outcome: "applied" });
    await testApp.orchestrator.shutdown();
    expect(await queue()).toEqual([expect.objectContaining({ text: "after the restart" })]);

    const orchestrator = new Orchestrator({ ports: testApp.ports, index: testApp.index, log: testApp.log, product: { repoPath: TEST_REPO_PATH } });
    restarted.push(orchestrator);
    await orchestrator.pollOnce();
    const resumed = testApp.ports.driver.lastLaunch();
    expect(resumed.launch).toMatchObject({ resume: SESSION });
    expect(resumed.sent).toEqual([]);
    resumed.emit(sdkMessages.init(SESSION));
    resumed.emit(sdkMessages.resultSuccess(SESSION, "resumed turn done"));
    await flush();
    expect(resumed.sent).toEqual(["after the restart"]);
    expect(testApp.index.dialogue.listUndelivered()).toEqual([]);
  });
});
