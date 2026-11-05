import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_IDLE_TIMEOUT_MS } from "../../src/agents/agent-runner.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId } from "../../src/ids.js";
import type { Issue } from "../../src/ports/github.js";
import { createTestApp, TEST_REPO_PATH, type TestApp } from "../helpers/test-app.js";

const SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const ISSUE = 42 as IssueNumber;
const WORKTREE = `${TEST_REPO_PATH}/.claude/worktrees/issue-42`;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Scenario = TestApp & { issue: Issue };

const seedTask = (testApp: TestApp, overrides: Partial<Parameters<TestApp["ports"]["github"]["seedIssue"]>[0]> = {}): Issue => {
  const { github } = testApp.ports;
  github.seedIssue({
    number: 7,
    title: "Accounts",
    type: "Epic",
    body: "Goal\n\n- [ ] Users can log in\n- [x] Users can register\n",
  });
  return github.seedIssue({
    number: 42,
    title: "Add login",
    body: "## What to build\n\nA login form.",
    labels: ["ready-for-agent"],
    parentIssueNumber: 7 as IssueNumber,
    ...overrides,
  });
};

describe("Implementation Stage", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  const taken = async (): Promise<Scenario> => {
    const testApp = createTestApp();
    open.push(testApp);
    const issue = seedTask(testApp);
    await testApp.orchestrator.pollOnce();
    return { ...testApp, issue };
  };

  it("starts the Implementer in the worktree of the taken Task with the issue, Epic, criteria, pull request and branch in the prompt", async () => {
    const s = await taken();
    const { driver } = s.ports;

    expect(driver.launches).toHaveLength(1);
    const launch = driver.lastLaunch().launch;
    expect(launch.cwd).toBe(WORKTREE);
    expect(launch.resume).toBeUndefined();
    const prompt = launch.prompt ?? "";
    expect(prompt).toContain("Issue #42: Add login");
    expect(prompt).toContain("A login form.");
    expect(prompt).toContain("Epic #7: Accounts");
    expect(prompt).toContain("- [ ] Users can log in\n- [ ] Users can register");
    expect(prompt).toContain("Pull request: #1");
    expect(prompt).toContain("Ветка: `worktree-issue-42`");
    expect(prompt).toContain(`Worktree Задачи: \`${WORKTREE}\``);
    expect(prompt).toContain("## Критерии Epic");

    const agents = s.index.agents.listByIssue(ISSUE);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ role: "implementer", cwd: WORKTREE, state: "running" });
    expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
    expect(s.index.transitions.listFor(ISSUE).map((t) => [t.from, t.to])).toEqual([
      [null, "taken"],
      ["taken", "implement"],
    ]);
  });

  it("finds the Epic through the Part of line when sub-issues are not used", async () => {
    const testApp = createTestApp();
    open.push(testApp);
    seedTask(testApp, { parentIssueNumber: null, body: "Part of #7\n\nA login form." });
    await testApp.orchestrator.pollOnce();

    expect(testApp.ports.driver.lastLaunch().launch.prompt).toContain("Epic #7: Accounts");
  });

  it("moves the Task to QA when the Implementer finishes its Turn, and only then", async () => {
    const s = await taken();
    const process = s.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));
    process.emit(sdkMessages.assistantText(SESSION, "working"));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("implement");

    await s.ports.clock.advance(1_000);
    process.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();

    const now = new Date(s.ports.clock.now()).toISOString();
    expect(s.index.tasks.get(ISSUE).stage).toBe("qa");
    expect(s.index.transitions.listFor(ISSUE).at(-1)).toMatchObject({ from: "implement", to: "qa", at: now });
    expect(s.index.agents.listByIssue(ISSUE)[0]).toMatchObject({ state: "idle", sessionId: SESSION });
  });

  it("keeps the Task in the Stage when the Turn is deferred by ask_human or ends with an error", async () => {
    const s = await taken();
    const process = s.ports.driver.lastLaunch();
    process.emit(sdkMessages.init(SESSION));
    process.emit(sdkMessages.resultSuccess(SESSION, "", { stop_reason: "tool_deferred", terminal_reason: "tool_deferred" }));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
    expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("waiting");

    const other = createTestApp();
    open.push(other);
    seedTask(other);
    await other.orchestrator.pollOnce();
    const failing = other.ports.driver.lastLaunch();
    failing.emit(sdkMessages.init(SESSION));
    failing.emit(sdkMessages.resultError(SESSION, ["boom"]));
    await flush();
    expect(other.index.tasks.get(ISSUE).stage).toBe("implement");
  });

  it("keeps one Session: a later message goes into the live process or resumes the same session id", async () => {
    const s = await taken();
    const { driver, clock } = s.ports;
    const first = driver.lastLaunch();
    first.emit(sdkMessages.init(SESSION));
    first.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("qa");

    await s.orchestrator.implementation.send(ISSUE, "QA blockers: fix the form");
    expect(first.sent).toEqual(["QA blockers: fix the form"]);
    expect(driver.launches).toHaveLength(1);
    expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
    expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("running");

    first.emit(sdkMessages.resultSuccess(SESSION, "fixed"));
    await flush();
    expect(s.index.tasks.get(ISSUE).stage).toBe("qa");
    await clock.advance(DEFAULT_IDLE_TIMEOUT_MS);
    await flush();
    expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("stopped");

    await s.orchestrator.implementation.send(ISSUE, "more blockers");
    expect(driver.launches).toHaveLength(2);
    expect(driver.lastLaunch().launch).toMatchObject({ cwd: WORKTREE, resume: SESSION, prompt: "more blockers" });
    expect(s.index.agents.listByIssue(ISSUE)).toHaveLength(1);
    expect(s.index.tasks.get(ISSUE).stage).toBe("implement");
  });

  it("counts a Slot for running and idle Agents only", async () => {
    const s = await taken();
    const { driver, clock } = s.ports;
    const process = driver.lastLaunch();
    expect(s.orchestrator.slots()).toEqual({ used: 1, max: 2 });

    process.emit(sdkMessages.init(SESSION));
    process.emit(sdkMessages.resultSuccess(SESSION, "done"));
    await flush();
    expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("idle");
    expect(s.orchestrator.slots()).toEqual({ used: 1, max: 2 });

    await clock.advance(DEFAULT_IDLE_TIMEOUT_MS);
    await flush();
    expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("stopped");
    expect(s.orchestrator.slots()).toEqual({ used: 0, max: 2 });

    await s.orchestrator.implementation.send(ISSUE, "blockers");
    expect(s.orchestrator.slots()).toEqual({ used: 1, max: 2 });

    const resumed = driver.lastLaunch();
    resumed.emit(sdkMessages.resultSuccess(SESSION, "", { stop_reason: "tool_deferred", terminal_reason: "tool_deferred" }));
    resumed.end();
    await flush();
    expect(s.index.agents.listByIssue(ISSUE)[0]?.state).toBe("waiting");
    expect(s.orchestrator.slots()).toEqual({ used: 0, max: 2 });
  });

  it("retries the Implementer on the next cycle when the launch failed", async () => {
    const testApp = createTestApp();
    open.push(testApp);
    seedTask(testApp);
    const { driver } = testApp.ports;
    const launch = driver.launch.bind(driver);
    driver.launch = () => {
      throw new Error("claude not found");
    };
    await testApp.orchestrator.pollOnce();
    expect(testApp.index.tasks.get(ISSUE).stage).toBe("taken");
    expect(testApp.index.agents.listByIssue(ISSUE)).toHaveLength(0);
    expect(testApp.orchestrator.slots().used).toBe(1);

    driver.launch = launch;
    await testApp.orchestrator.pollOnce();
    expect(driver.launches).toHaveLength(1);
    expect(testApp.index.tasks.get(ISSUE).stage).toBe("implement");
  });
});
