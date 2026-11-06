import { afterEach, describe, expect, it } from "vitest";
import type { FakeAgentProcess } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import { INSTALLATION_KEYS } from "../../src/orchestrator/orchestrator.js";
import { PLANNER_KEYS, RESUME_PROMPT } from "../../src/orchestrator/planner.js";
import type { AgentHistoryResponse, PlannerResponse, ServerEvent } from "../../src/server/app.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";
import { WsClient } from "../helpers/ws-client.js";

const SESSION = "22222222-2222-4222-8222-222222222222" as SessionId;
const OTHER_SESSION = "33333333-3333-4333-8333-333333333333" as SessionId;
const TAB = "tab-plan";

type Ack = Extract<ServerEvent, { type: "ack" }>;

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the planning mode", () => {
  let testApp: TestApp;
  let server: RunningServer | undefined;
  const clients: WsClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    await server?.close();
    server = undefined;
    await testApp?.orchestrator.shutdown();
    testApp?.close();
    // Each scenario builds its own Installation.
    testApp = undefined as unknown as TestApp;
  });

  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const state = async (): Promise<PlannerResponse> => {
    const response = await testApp.request("/api/planner");
    expect(response.status).toBe(200);
    return (await response.json()) as PlannerResponse;
  };

  const start = async (body: unknown): Promise<Response> => {
    const response = await testApp.request("/api/planner/start", json(body));
    await flush();
    return response;
  };

  const finish = async (): Promise<PlannerResponse> => {
    const response = await testApp.request("/api/planner/finish", json({}));
    expect(response.status).toBe(200);
    await flush();
    return (await response.json()) as PlannerResponse;
  };

  const planners = () => testApp.ports.driver.launches.filter((process) => process.launch.cwd === TEST_REPO_PATH);

  // A new planning Session whose first Turn has begun.
  const started = async (message?: string): Promise<FakeAgentProcess> => {
    testApp ??= createTestApp();
    const response = await start({ mode: "new", ...(message !== undefined ? { message } : {}) });
    expect(response.status).toBe(200);
    const process = testApp.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));
    await flush();
    return process;
  };

  const endTurn = async (process: FakeAgentProcess, text = "Готово."): Promise<void> => {
    process.emit(sdkMessages.resultSuccess(SESSION, text));
    await flush();
  };

  const connect = async (): Promise<WsClient> => {
    server ??= await startServer({ app: testApp.app, host: "127.0.0.1", port: 0, log: testApp.log });
    const client = await WsClient.connect(`${server.url.replace("http", "ws")}/ws`, { cookie: await testApp.login(), origin: server.url });
    clients.push(client);
    expect(await client.next()).toMatchObject({ type: "hello" });
    return client;
  };

  const ack = async (ws: WsClient, frame: Record<string, unknown>): Promise<Ack> => {
    ws.send(frame);
    for (let i = 0; i < 30; i += 1) {
      const event = (await ws.next()) as ServerEvent;
      if (event.type === "ack") return event;
    }
    throw new Error("no ack");
  };

  const plannerFrame = (seq: number, text: string) => ({ type: "dialogue", to: "planner", clientId: TAB, seq, text });

  it("starts the Planner on the clone of main with the plan prompt, outside the worktrees", async () => {
    testApp = createTestApp();
    expect(await state()).toMatchObject({ status: "none", open: false, canResume: false, agent: null });

    const process = await started("Хочу экспорт отчётов в CSV");

    const { launch } = process;
    expect(launch.cwd).toBe(TEST_REPO_PATH);
    expect(launch.resume).toBeUndefined();
    // The clone is fetched and put on main at origin/main before the Session starts.
    const worktree = testApp.ports.worktree.log.calls.map((call) => call.method);
    expect(worktree).toEqual(expect.arrayContaining(["fetch", "checkout"]));
    expect(testApp.ports.worktree.log.of("checkout")[0]!.args[0]).toEqual({ repoPath: TEST_REPO_PATH, branch: "main", base: "origin/main" });
    expect(testApp.ports.worktree.currentBranch(TEST_REPO_PATH)).toBe("main");
    expect(testApp.ports.worktree.log.of("addWorktree")).toEqual([]);

    // The prompt binds the Planner to the tracker contract, to reading first and to touching no files.
    const prompt = launch.prompt ?? "";
    expect(prompt).toContain(TEST_REPO_PATH);
    expect(prompt).toContain("docs/agents/issue-tracker.md");
    expect(prompt).toContain("milestones");
    expect(prompt).toContain("gh issue list");
    expect(prompt).toMatch(/код/);
    expect(prompt).toContain("не делай коммитов");
    expect(prompt).toContain("ready-for-agent");
    expect(prompt).toContain("blocked_by");
    expect(prompt).toContain("/wayfinder");
    expect(prompt).toContain("/to-spec");
    expect(prompt).toContain("/to-tickets");
    expect(prompt).toContain("Существующие issues правь только по явной просьбе");
    expect(prompt).toContain("Хочу экспорт отчётов в CSV");

    const view = await state();
    expect(view).toMatchObject({ status: "running", open: true, sessionId: SESSION, agent: { role: "planner", state: "running" } });
    expect(testApp.index.agents.get(view.agent!.id as never).issueNumber).toBeNull();
    expect(testApp.index.installation.find(PLANNER_KEYS.lastSession)).toBe(SESSION);
  });

  it("takes no Slot: with max_parallel_tasks 1 a Ready Task is taken while the Planner works", async () => {
    testApp = createTestApp();
    testApp.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, "1");
    await started();

    testApp.ports.github.seedIssue({ number: 7, title: "Export", body: "Build it.", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();

    expect(testApp.index.tasks.find(7 as IssueNumber)?.stage).toBe("implement");
    expect(testApp.orchestrator.slots()).toEqual({ used: 1, max: 1 });
    expect(planners().length).toBe(1);
  });

  it("takes the Tasks the Planner created on the next poll", async () => {
    testApp = createTestApp();
    const process = await started("Разбей экспорт на задачи");
    await testApp.orchestrator.pollOnce();
    expect(testApp.index.tasks.listActive()).toEqual([]);

    // The Planner writes to GitHub through `gh`: an Epic without the label and two Tasks, one blocked.
    testApp.ports.github.seedIssue({ number: 10, title: "Epic: export", body: "## Критерии закрытия\n\n- [ ] CSV" });
    testApp.ports.github.seedIssue({ number: 11, title: "CSV writer", body: "## Parent\n\nPart of #10", labels: ["ready-for-agent"] });
    await endTurn(process, "Создал #10 и #11.");
    await testApp.orchestrator.pollOnce();

    expect(testApp.index.tasks.find(11 as IssueNumber)?.stage).toBe("implement");
    expect(testApp.index.tasks.find(10 as IssueNumber)).toBeUndefined();
  });

  it("refuses a second Planner while one runs", async () => {
    const first = await started();
    const second = await start({ mode: "new" });
    expect(second.status).toBe(409);
    expect(planners()).toEqual([first]);
    const again = await start({ mode: "resume" });
    expect(again.status).toBe(409);
    expect(planners()).toEqual([first]);
  });

  it("finish stops the process and keeps the Session; resume continues the same session id", async () => {
    const first = await started();
    await endTurn(first);

    const finished = await finish();
    expect(first.log.methods()).toContain("stop");
    expect(finished).toMatchObject({ status: "stopped", open: false, canResume: true, sessionId: SESSION });
    expect(testApp.index.installation.find(PLANNER_KEYS.lastSession)).toBe(SESSION);

    const resumed = await start({ mode: "resume" });
    expect(resumed.status).toBe(200);
    const process = testApp.ports.driver.lastLaunch();
    expect(process).not.toBe(first);
    expect(process.launch.resume).toBe(SESSION);
    expect(process.launch.cwd).toBe(TEST_REPO_PATH);
    expect(process.launch.prompt).toBe(RESUME_PROMPT);
    expect(await state()).toMatchObject({ status: "running", open: true, sessionId: SESSION });

    await finish();
    const withMessage = await start({ mode: "resume", message: "Добавь ещё milestone для импорта" });
    expect(withMessage.status).toBe(200);
    expect(testApp.ports.driver.lastLaunch().launch).toMatchObject({ resume: SESSION, prompt: "Добавь ещё milestone для импорта" });
  });

  it("a new Session after finish starts fresh and becomes the one to resume", async () => {
    const first = await started();
    await endTurn(first);
    await finish();

    expect((await start({ mode: "new" })).status).toBe(200);
    const second = testApp.ports.driver.lastLaunch();
    expect(second.launch.resume).toBeUndefined();
    second.emit(sdkMessages.init(OTHER_SESSION));
    await flush();
    expect(testApp.index.installation.find(PLANNER_KEYS.lastSession)).toBe(OTHER_SESSION);

    await finish();
    await start({ mode: "resume" });
    expect(testApp.ports.driver.lastLaunch().launch.resume).toBe(OTHER_SESSION);
  });

  it("resume without a previous Session is refused; a bad body is a 400", async () => {
    testApp = createTestApp();
    expect((await start({ mode: "resume" })).status).toBe(404);
    expect((await start({ mode: "later" })).status).toBe(400);
    expect((await start({ mode: "new", message: 5 })).status).toBe(400);
    expect(testApp.ports.driver.launches).toEqual([]);
  });

  it("finish with no Planner running is harmless", async () => {
    testApp = createTestApp();
    expect(await finish()).toMatchObject({ status: "none", open: false });
  });

  it("delivers lines of the chat over the Dialogue frame, once each, at the end of the Turn", async () => {
    const process = await started();
    const ws = await connect();

    expect(await ack(ws, plannerFrame(1, "Сделай три задачи"))).toEqual({ type: "ack", clientId: TAB, seq: 1, watermark: 1, outcome: "applied", reason: null });
    // The Turn runs: the line waits.
    expect(process.sent).toEqual([]);
    expect((await state()).queue).toMatchObject([{ seq: 1, text: "Сделай три задачи" }]);

    // The same frame again after a lost ACK is confirmed, not queued twice.
    expect(await ack(ws, plannerFrame(1, "Сделай три задачи"))).toMatchObject({ seq: 1, outcome: "duplicate" });
    expect((await state()).queue).toHaveLength(1);

    await endTurn(process);
    expect(process.sent).toEqual(["Сделай три задачи"]);
    expect((await state()).queue).toEqual([]);

    // Between Turns a line goes in at once; the process is the same.
    await endTurn(process);
    expect(await ack(ws, plannerFrame(2, "Да, создавай"))).toMatchObject({ outcome: "applied" });
    await flush();
    expect(process.sent).toEqual(["Сделай три задачи", "Да, создавай"]);
    expect(planners()).toHaveLength(1);
  });

  it("refuses a chat line when planning is not started and a frame with an unknown address", async () => {
    testApp = createTestApp();
    const ws = await connect();
    expect(await ack(ws, plannerFrame(1, "Привет"))).toMatchObject({ seq: 1, outcome: "rejected", reason: "the Planner is not started" });
    expect(await ack(ws, { type: "dialogue", to: "nobody", clientId: TAB, seq: 2, text: "x" })).toMatchObject({ seq: 2, outcome: "rejected" });
    expect(testApp.ports.driver.launches).toEqual([]);
  });

  it("a line queued then taken back never reaches the Session", async () => {
    const process = await started();
    const ws = await connect();
    await ack(ws, plannerFrame(1, "Отмени это"));
    const [line] = (await state()).queue;
    const removed = await testApp.request(`/api/planner/queue/${line!.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await testApp.request(`/api/planner/queue/${line!.id}`, { method: "DELETE" })).status).toBe(404);
    await endTurn(process);
    expect(process.sent).toEqual([]);
  });

  it("a line after the idle timeout resumes the same Session with the line as its prompt", async () => {
    const process = await started();
    await endTurn(process);
    // The process went away on its own (the idle timeout); the chat is still open.
    process.end();
    await flush();
    expect((await state()).status).toBe("stopped");

    const ws = await connect();
    expect(await ack(ws, plannerFrame(1, "Продолжай"))).toMatchObject({ outcome: "applied" });
    await flush();
    const resumed = testApp.ports.driver.lastLaunch();
    expect(resumed).not.toBe(process);
    expect(resumed.launch).toMatchObject({ resume: SESSION, prompt: "Продолжай", cwd: TEST_REPO_PATH });
  });

  it("gives the Planner no ask_human: the Driver denies the call and no Request is published", async () => {
    const process = await started();
    // Without a handler the Driver answers the hook with deny; the Planner asks in the chat instead.
    expect(process.launch.onAskHuman).toBeUndefined();
    expect(process.launch.prompt).toContain("Tool `ask_human` тебе недоступен");
    await endTurn(process);
    await testApp.orchestrator.pollOnce();
    expect(testApp.index.humanRequests.listOpen()).toEqual([]);
  });

  it("serves the transcript of the Session for the feed and interrupts a Turn", async () => {
    const process = await started();
    testApp.ports.driver.histories.set(SESSION, [sdkMessages.userText(SESSION, "Привет")]);
    const history = await testApp.request("/api/planner/history");
    expect(history.status).toBe(200);
    const body = (await history.json()) as AgentHistoryResponse;
    expect(body).toMatchObject({ sessionId: SESSION, agent: { role: "planner" } });
    expect(body.history).toHaveLength(1);

    expect((await testApp.request("/api/planner/interrupt", json({}))).status).toBe(200);
    expect(process.log.methods()).toContain("interrupt");
    await endTurn(process);
    expect((await testApp.request("/api/planner/interrupt", json({}))).status).toBe(409);
  });

  it("announces changes of the Planner over the socket", async () => {
    testApp = createTestApp();
    const ws = await connect();
    await start({ mode: "new" });
    let seen = false;
    for (let i = 0; i < 10 && !seen; i += 1) seen = ((await ws.next()) as ServerEvent).type === "planner";
    expect(seen).toBe(true);
  });
});
