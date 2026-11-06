import { afterEach, describe, expect, it } from "vitest";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, MilestoneNumber, PullNumber, SessionId } from "../../src/ids.js";
import { isMarkedComment } from "../../src/orchestrator/comments.js";
import { criteriaOfPullBody, EPIC_CRITERIA_HEADING, MILESTONE_SWEEP_INTERVAL_MS, tickCriteria } from "../../src/orchestrator/epic-closure.js";
import type { IssueSeed } from "../../src/fakes/github.js";
import { INSTALLATION_KEYS } from "../../src/orchestrator/orchestrator.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

const IMPLEMENTER_SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;
const QA_SESSION = "22222222-2222-4222-8222-222222222222" as SessionId;
const TASK = 42 as IssueNumber;
const EPIC = 10 as IssueNumber;
const SPEC = 11 as IssueNumber;
const OTHER_TASK = 43 as IssueNumber;
const MILESTONE = { number: 1 as MilestoneNumber, title: "Эпик 1: Вход" };
const PULL = 1 as PullNumber;

const EPIC_BODY = [
  "Зонтик входа.",
  "",
  "## Критерии закрытия",
  "",
  "- [ ] Пользователь входит по email и паролю",
  "- [ ] Пароль можно сбросить по ссылке из письма",
  "- [x] Форма входа свёрстана",
].join("\n");

const pullBody = (criteria: string[]): string =>
  ["Closes #42", "", "## Что сделано", "", "- форма", "", "## Как проверить", "", "npm test", "", EPIC_CRITERIA_HEADING, "", ...criteria].join("\n");

const approved = JSON.stringify({ approved: true, summary: "Всё на месте", blockers: [] });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

// Calls that change issues, milestones or comments: the closure must make only the ones the scenario needs.
const MUTATIONS = new Set(["updateIssue", "updateMilestone", "addLabels", "removeLabel", "createIssueComment"]);

// The Implementer just taken finishes its Turn and the QA round approves: the Task reaches `merge`.
const finishPipeline = async (testApp: TestApp, implementerSession: SessionId, qaSession: SessionId): Promise<void> => {
  const implementer = testApp.ports.driver.lastLaunch();
  implementer.emit(sdkMessages.init(implementerSession));
  implementer.emit(sdkMessages.resultSuccess(implementerSession, "done"));
  await flush();
  const qa = testApp.ports.driver.lastLaunch();
  qa.emit(sdkMessages.init(qaSession));
  qa.emit(sdkMessages.resultSuccess(qaSession, approved));
  await flush();
};

type Layout = {
  // Issues of the milestone next to the Task; the Task itself is seeded by the scenario.
  issues?: IssueSeed[];
  task?: Partial<IssueSeed>;
  pullBody?: string;
  setup?: (testApp: TestApp) => void;
};

describe("Epic criteria and milestone closure after a merge", () => {
  const open: TestApp[] = [];
  afterEach(async () => {
    for (const testApp of open.splice(0)) {
      await testApp.orchestrator.shutdown();
      testApp.close();
    }
  });

  // The Task goes through Implementation and QA to `merge`; the Implementer "filled" the pull request body.
  const approvedTask = async (layout: Layout = {}): Promise<TestApp> => {
    const testApp = createTestApp();
    open.push(testApp);
    const { github } = testApp.ports;
    layout.setup?.(testApp);
    github.seedMilestone({ number: MILESTONE.number, title: MILESTONE.title });
    for (const seed of layout.issues ?? []) github.seedIssue(seed);
    github.seedIssue({ number: TASK, title: "Add login", body: "A login form.", labels: ["ready-for-agent"], ...layout.task });
    await testApp.orchestrator.pollOnce();
    await finishPipeline(testApp, IMPLEMENTER_SESSION, QA_SESSION);
    expect(testApp.index.tasks.get(TASK).stage).toBe("merge");
    if (layout.pullBody !== undefined) await github.updatePullRequest(PULL, { body: layout.pullBody });
    github.log.clear();
    return testApp;
  };

  const mutationsOf = (s: TestApp, issue: number) =>
    s.ports.github.log.calls.filter((call) => MUTATIONS.has(call.method) && call.args[0] === issue).map((call) => [call.method, call.args[1]]);

  const epicLayout = (overrides: { otherTaskState?: "open" | "closed"; epicBody?: string } = {}): Layout => ({
    issues: [
      { number: EPIC, title: "Вход", body: overrides.epicBody ?? EPIC_BODY, milestone: MILESTONE },
      { number: SPEC, title: "Спека входа", body: "Спека.", milestone: MILESTONE },
      { number: OTHER_TASK, title: "Reset password", body: "", milestone: MILESTONE, parentIssueNumber: EPIC, state: overrides.otherTaskState ?? "closed" },
    ],
    task: { milestone: MILESTONE, parentIssueNumber: EPIC },
  });

  it("ticks the criteria of the pull request in the Epic and leaves the other lines alone while an issue of the milestone is open", async () => {
    const s = await approvedTask({
      ...epicLayout({ otherTaskState: "open" }),
      pullBody: pullBody(["- [ ] Пользователь входит по email и паролю", "- [ ] Критерий, которого в Epic нет"]),
    });
    const { github } = s.ports;

    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(TASK).stage).toBe("done");
    expect(github.issue(EPIC).body).toBe(
      [
        "Зонтик входа.",
        "",
        "## Критерии закрытия",
        "",
        "- [x] Пользователь входит по email и паролю",
        "- [ ] Пароль можно сбросить по ссылке из письма",
        "- [x] Форма входа свёрстана",
      ].join("\n"),
    );
    expect(mutationsOf(s, EPIC)).toEqual([["updateIssue", { body: github.issue(EPIC).body }]]);
    expect(github.issue(EPIC).state).toBe("open");
    expect(github.issue(SPEC).state).toBe("open");
    expect(github.milestone(MILESTONE.number).state).toBe("open");
    expect(github.issue(EPIC).labels).toEqual([]);
    expect(github.commentsOf(EPIC)).toEqual([]);
    expect(s.index.intents.listPending()).toEqual([]);
  });

  it("closes the Epic, the Spec and the milestone once every issue is closed and every criterion ticked", async () => {
    const s = await approvedTask({
      ...epicLayout(),
      pullBody: pullBody(["- [ ] Пользователь входит по email и паролю", "- [ ] Пароль можно сбросить по ссылке из письма"]),
    });
    const { github } = s.ports;

    await s.orchestrator.pollOnce();

    expect(github.issue(TASK)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(github.issue(EPIC)).toMatchObject({ state: "closed", stateReason: "completed", labels: [] });
    expect(github.issue(SPEC)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(github.milestone(MILESTONE.number).state).toBe("closed");
    expect(github.issue(EPIC).body).toContain("- [x] Пароль можно сбросить");
    expect(mutationsOf(s, EPIC)).toEqual([
      ["updateIssue", { body: github.issue(EPIC).body }],
      ["updateIssue", { state: "closed", stateReason: "completed" }],
    ]);
    expect(mutationsOf(s, SPEC)).toEqual([["updateIssue", { state: "closed", stateReason: "completed" }]]);
    expect(github.log.of("updateMilestone").map((call) => call.args)).toEqual([[MILESTONE.number, { state: "closed" }]]);
    expect(github.commentsOf(EPIC)).toEqual([]);
    expect(s.index.tasks.get(TASK).stage).toBe("done");
  });

  it("finds the Epic and the Spec by issue type when the repository has types and the Task has no parent", async () => {
    const s = await approvedTask({
      issues: [
        { number: EPIC, title: "Вход", body: "- [ ] Пользователь входит по email и паролю", milestone: MILESTONE, type: "Epic" },
        { number: SPEC, title: "Спека входа", body: "Спека.", milestone: MILESTONE, type: "Spec" },
        { number: 12, title: "Заметка", body: "", milestone: MILESTONE, type: "Task", state: "closed" },
      ],
      task: { milestone: MILESTONE, type: "Task" },
      pullBody: pullBody(["Пользователь входит по email и паролю"]),
    });
    const { github } = s.ports;

    await s.orchestrator.pollOnce();

    expect(github.issue(EPIC)).toMatchObject({ state: "closed", body: "- [x] Пользователь входит по email и паролю" });
    expect(github.issue(SPEC).state).toBe("closed");
    expect(github.milestone(MILESTONE.number).state).toBe("closed");
  });

  it("hands the Epic to the human when the issues are closed but criteria remain: label, one explaining comment, milestone open", async () => {
    const s = await approvedTask({ ...epicLayout(), pullBody: pullBody(["- [ ] Пользователь входит по email и паролю"]) });
    const { github } = s.ports;

    await s.orchestrator.pollOnce();

    expect(github.issue(EPIC)).toMatchObject({ state: "open", labels: ["ready-for-human"] });
    expect(github.issue(SPEC).state).toBe("open");
    expect(github.milestone(MILESTONE.number).state).toBe("open");
    expect(github.log.of("updateMilestone")).toEqual([]);
    const comments = github.commentsOf(EPIC);
    expect(comments).toHaveLength(1);
    expect(isMarkedComment(comments[0]?.body ?? "")).toBe(true);
    expect(comments[0]?.body).toContain("Пароль можно сбросить по ссылке из письма");
    expect(comments[0]?.body).not.toContain("Пользователь входит по email и паролю");
    expect(comments[0]?.body).toContain(MILESTONE.title);
    expect(s.index.tasks.get(TASK).stage).toBe("done");

    // Another cycle: nothing changed, nothing is repeated.
    github.log.clear();
    await s.orchestrator.pollOnce();
    expect(mutationsOf(s, EPIC)).toEqual([]);
    expect(github.commentsOf(EPIC)).toHaveLength(1);
  });

  it("closes the Epic, the Spec and the milestone once the human ticks the remaining criteria, on the next sweep", async () => {
    const s = await approvedTask({ ...epicLayout(), pullBody: pullBody(["- [ ] Пользователь входит по email и паролю"]) });
    const { github, clock } = s.ports;
    await s.orchestrator.pollOnce();
    expect(github.issue(EPIC)).toMatchObject({ state: "open", labels: ["ready-for-human"] });

    github.humanUpdateIssue(EPIC, { body: github.issue(EPIC).body.replace("- [ ] Пароль можно сбросить", "- [x] Пароль можно сбросить") });
    await s.orchestrator.pollOnce();
    expect(github.milestone(MILESTONE.number).state).toBe("open");

    await clock.advance(MILESTONE_SWEEP_INTERVAL_MS);
    await s.orchestrator.pollOnce();
    expect(github.issue(EPIC).state).toBe("closed");
    expect(github.issue(SPEC).state).toBe("closed");
    expect(github.milestone(MILESTONE.number).state).toBe("closed");
    expect(github.commentsOf(EPIC)).toHaveLength(1);

    // Closed for good: later sweeps leave it alone.
    github.log.clear();
    await clock.advance(MILESTONE_SWEEP_INTERVAL_MS);
    await s.orchestrator.pollOnce();
    expect(github.log.of("updateMilestone")).toEqual([]);
    expect(github.log.of("getMilestone")).toEqual([]);
  });

  it("closes the milestone on the sweep when the human closes its last open issue after the merge", async () => {
    const s = await approvedTask({
      ...epicLayout({ otherTaskState: "open" }),
      pullBody: pullBody(["- [ ] Пользователь входит по email и паролю", "- [ ] Пароль можно сбросить по ссылке из письма"]),
    });
    const { github, clock } = s.ports;
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(TASK).stage).toBe("done");
    expect(github.milestone(MILESTONE.number).state).toBe("open");

    github.humanUpdateIssue(OTHER_TASK, { state: "closed" });
    await clock.advance(MILESTONE_SWEEP_INTERVAL_MS);
    await s.orchestrator.pollOnce();
    expect(github.issue(EPIC).state).toBe("closed");
    expect(github.milestone(MILESTONE.number).state).toBe("closed");
  });

  it("finishes a closure interrupted by a GitHub error on the next cycle without editing the body or commenting twice", async () => {
    const s = await approvedTask({
      ...epicLayout(),
      pullBody: pullBody(["- [ ] Пользователь входит по email и паролю", "- [ ] Пароль можно сбросить по ссылке из письма"]),
    });
    const { github } = s.ports;
    const updateMilestone = github.updateMilestone.bind(github);
    github.updateMilestone = async (number, patch) => {
      github.log.record("updateMilestone", number, patch);
      throw new Error("502 Bad Gateway");
    };

    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(TASK).stage).toBe("merge");
    expect(s.index.intents.listPending().map((intent) => intent.kind)).toEqual(["settle-epic"]);
    expect(github.issue(EPIC).state).toBe("closed");
    expect(github.milestone(MILESTONE.number).state).toBe("open");

    github.updateMilestone = updateMilestone;
    await s.orchestrator.pollOnce();
    expect(github.milestone(MILESTONE.number).state).toBe("closed");
    expect(mutationsOf(s, EPIC)).toEqual([
      ["updateIssue", { body: github.issue(EPIC).body }],
      ["updateIssue", { state: "closed", stateReason: "completed" }],
    ]);
    expect(github.commentsOf(EPIC)).toEqual([]);
    expect(github.commentsOf(TASK).filter((c) => isMarkedComment(c.body, "done:1"))).toHaveLength(1);
    expect(s.index.tasks.get(TASK).stage).toBe("done");
    expect(s.index.intents.listPending()).toEqual([]);
  });

  it("does nothing for a Task without a milestone and without an Epic, and reads nothing extra", async () => {
    const s = await approvedTask({ pullBody: pullBody(["- [ ] Пользователь входит по email и паролю"]) });
    const { github } = s.ports;

    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(TASK).stage).toBe("done");
    expect(github.log.methods().filter((method) => ["getIssue", "listIssues", "listSubIssues", "getMilestone", "updateMilestone"].includes(method))).toEqual([]);
    expect(github.log.of("updateIssue").map((call) => call.args)).toEqual([[TASK, { state: "closed", stateReason: "completed" }]]);
    expect(s.index.intents.listFor(TASK).map((intent) => intent.kind)).not.toContain("settle-epic");
  });

  it("closes a flat milestone without an Epic when its last issue is closed, and touches no other issue", async () => {
    const s = await approvedTask({
      issues: [{ number: 12, title: "Заметка без метки", body: "", milestone: MILESTONE, state: "closed" }],
      task: { milestone: MILESTONE },
      pullBody: pullBody(["нет"]),
    });
    const { github } = s.ports;

    await s.orchestrator.pollOnce();

    expect(github.milestone(MILESTONE.number).state).toBe("closed");
    expect(mutationsOf(s, 12)).toEqual([]);
    expect(github.log.of("getIssue")).toEqual([]);
  });

  it("leaves a flat milestone open while another issue of it is open", async () => {
    const s = await approvedTask({
      issues: [{ number: 12, title: "Ещё задача", body: "", milestone: MILESTONE, labels: ["ready-for-agent"] }],
      task: { milestone: MILESTONE },
      pullBody: pullBody(["нет"]),
    });
    const { github } = s.ports;

    await s.orchestrator.pollOnce();

    expect(github.milestone(MILESTONE.number).state).toBe("open");
    expect(github.log.of("updateMilestone")).toEqual([]);
  });

  it("ticks the criteria of an Epic outside any milestone and edits its body only when a line changes", async () => {
    const s = await approvedTask({
      issues: [{ number: EPIC, title: "Вход", body: EPIC_BODY }],
      task: { parentIssueNumber: EPIC },
      pullBody: pullBody(["- [x] Форма входа свёрстана", "- [ ] Критерий, которого в Epic нет"]),
    });
    const { github } = s.ports;

    await s.orchestrator.pollOnce();

    expect(s.index.tasks.get(TASK).stage).toBe("done");
    expect(github.issue(EPIC).body).toBe(EPIC_BODY);
    expect(mutationsOf(s, EPIC)).toEqual([]);
    expect(github.log.of("getIssue").map((call) => call.args)).toEqual([[EPIC]]);
    expect(github.log.of("listIssues")).toEqual([]);
  });

  it("does not repeat the comment or the label on the Epic when a later merge finds the same criteria unchecked", async () => {
    const s = await approvedTask({
      issues: [
        { number: EPIC, title: "Вход", body: EPIC_BODY, milestone: MILESTONE },
        { number: SPEC, title: "Спека входа", body: "Спека.", milestone: MILESTONE },
        { number: OTHER_TASK, title: "Reset password", body: "", milestone: MILESTONE, parentIssueNumber: EPIC, labels: ["ready-for-agent"] },
        { number: 44, title: "Remember me", body: "", milestone: MILESTONE, parentIssueNumber: EPIC, state: "closed" },
      ],
      task: { milestone: MILESTONE, parentIssueNumber: EPIC },
      pullBody: pullBody(["нет"]),
      setup: (testApp) => testApp.index.installation.set(INSTALLATION_KEYS.maxParallelTasks, "1"),
    });
    const { github } = s.ports;

    // The first merge leaves an open issue in the milestone: no comment yet. The next Task is taken right away.
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(TASK).stage).toBe("done");
    expect(github.commentsOf(EPIC)).toEqual([]);
    expect(s.index.tasks.get(OTHER_TASK).stage).toBe("implement");

    await finishPipeline(s, "33333333-3333-4333-8333-333333333333" as SessionId, "44444444-4444-4444-8444-444444444444" as SessionId);
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(OTHER_TASK).stage).toBe("done");
    expect(github.issue(EPIC).labels).toEqual(["ready-for-human"]);
    expect(github.commentsOf(EPIC)).toHaveLength(1);

    // A human reopens the closed issue for the agent; its merge finds the same criteria still unchecked.
    github.humanUpdateIssue(44, { state: "open" });
    github.humanSetLabels(44, ["ready-for-agent"]);
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(44 as IssueNumber).stage).toBe("implement");
    await finishPipeline(s, "55555555-5555-4555-8555-555555555555" as SessionId, "66666666-6666-4666-8666-666666666666" as SessionId);
    github.log.clear();
    await s.orchestrator.pollOnce();
    expect(s.index.tasks.get(44 as IssueNumber).stage).toBe("done");
    expect(mutationsOf(s, EPIC)).toEqual([]);
    expect(github.commentsOf(EPIC)).toHaveLength(1);
    expect(github.milestone(MILESTONE.number).state).toBe("open");
  });
});

describe("criteriaOfPullBody", () => {
  it("returns the lines under the section without bullets, checkboxes, blanks and the word «нет»", () => {
    const body = ["Closes #1", "", "## Критерии Epic", "", "- [ ] Первый", "* [x] Второй  ", "Третий", "", "нет", "## Другая секция", "- [ ] Не критерий"].join("\n");
    expect(criteriaOfPullBody(body)).toEqual(["Первый", "Второй", "Третий"]);
  });

  it("is empty without the section or with only «нет» under it", () => {
    expect(criteriaOfPullBody("Closes #1\n\n## Что сделано\n\n- всё")).toEqual([]);
    expect(criteriaOfPullBody("## Критерии Epic\n\nнет\n")).toEqual([]);
  });
});

describe("tickCriteria", () => {
  it("ticks exactly matching unchecked lines, keeps the others and the line endings", () => {
    const body = "Intro\r\n- [ ] A\r\n- [ ] B\r\n- [x] C\r\n  - [ ] A\r\n";
    expect(tickCriteria(body, ["A", "C", "D"])).toEqual({ body: "Intro\r\n- [x] A\r\n- [ ] B\r\n- [x] C\r\n  - [x] A\r\n", ticked: ["A"] });
  });

  it("reports nothing ticked for a body without matches", () => {
    expect(tickCriteria("- [ ] A", ["B"])).toEqual({ body: "- [ ] A", ticked: [] });
  });
});
