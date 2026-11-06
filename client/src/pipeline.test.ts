import { describe, expect, it } from "vitest";
import type { AgentId, IssueNumber } from "../../src/ids.js";
import type { TaskStage } from "../../src/index/tasks.js";
import type { AgentView, TaskView } from "../../src/server/api-types.js";
import { focusNodeOf, pipelineOf } from "./pipeline.js";

const ISSUE = 7 as IssueNumber;
const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

const agent = (id: number, role: AgentView["role"], minute: number, state: AgentView["state"] = "stopped"): AgentView => ({ id: id as AgentId, role, state, lastTurnAt: null, createdAt: at(minute) });

const task = (stage: TaskStage, moves: [TaskStage, string | null, number][], agents: AgentView[]): TaskView => ({
  issueNumber: ISSUE,
  title: "Seven",
  milestone: null,
  stage,
  round: 0,
  attempt: 1,
  pullNumber: null,
  branch: null,
  worktreePath: null,
  takenAt: at(0),
  updatedAt: at(0),
  htmlUrl: null,
  pullUrl: null,
  transitions: [["taken", null, 0] as [TaskStage, string | null, number], ...moves].map(([to, reason, minute], index, all) => ({
    id: index + 1,
    issueNumber: ISSUE,
    from: index === 0 ? null : all[index - 1]![0],
    to,
    reason,
    at: at(minute),
  })),
  agent: agents.at(-1) ?? null,
  agents,
  request: null,
});

const summary = (view: TaskView) =>
  pipelineOf(view).nodes.map((node) => [node.key, node.title, node.agent?.id ?? null, node.status, node.outcome]);

describe("pipelineOf", () => {
  it("gives every QA round and every return to the Implementer its own node", () => {
    const implementer = agent(1, "implementer", 0, "running");
    const view = task(
      "implement",
      [
        ["implement", "implementer started", 0],
        ["qa", "implementer turn finished", 10],
        ["implement", "qa round 1: 3 blockers", 15],
      ],
      [implementer, agent(2, "qa", 10)],
    );
    expect(summary(view)).toEqual([
      ["implement-0", "Реализация", 1, "ok", "готово"],
      ["qa-1", "QA · Круг 1", 2, "rejected", "3 замечания"],
      ["implement-2", "Правки", 1, "running", null],
      ["qa-next", "QA · Круг 2", null, "pending", null],
      ["merge-next", "Merge", null, "pending", null],
    ]);
    expect(focusNodeOf(pipelineOf(view))?.key).toBe("implement-2");
  });

  it("ends a merged Task with the approved round, the Merger and the end mark", () => {
    const view = task(
      "done",
      [
        ["implement", "implementer started", 0],
        ["qa", "implementer turn finished", 10],
        ["merge", "qa round 1: approved", 15],
        ["merge", "merger started: conflict with the base branch", 16],
        ["qa", "merger finished: extra qa round", 20],
        ["merge", "qa extra round: approved", 25],
        ["done", "pull request merged", 26],
      ],
      [agent(1, "implementer", 0), agent(2, "qa", 10), agent(3, "merger", 16), agent(4, "qa", 20)],
    );
    expect(summary(view)).toEqual([
      ["implement-0", "Реализация", 1, "ok", "готово"],
      ["qa-1", "QA · Круг 1", 2, "ok", "одобрено"],
      ["merge-2", "Merge", 3, "ok", "конфликт решён"],
      ["qa-3", "QA · доп. Круг", 4, "ok", "одобрено"],
      ["merge-4", "Merge", null, "ok", "влито"],
    ]);
    expect(pipelineOf(view).end).toBe("done");
  });

  it("marks the step a dead end stopped and shows a Task that has no transition into work yet", () => {
    const stuck = task(
      "stuck",
      [
        ["implement", "implementer started", 0],
        ["qa", "implementer turn finished", 10],
        ["stuck", "qa rounds exhausted: 3 of 3", 15],
      ],
      [agent(1, "implementer", 0), agent(2, "qa", 10)],
    );
    expect(summary(stuck).at(-1)).toEqual(["qa-1", "QA · Круг 1", 2, "failed", "тупик"]);
    expect(pipelineOf(stuck).end).toBe("stuck");

    const taken = task("taken", [], []);
    expect(summary(taken)).toEqual([
      ["implement-0", "Реализация", null, "running", null],
      ["qa-next", "QA · Круг 1", null, "pending", null],
      ["merge-next", "Merge", null, "pending", null],
    ]);
  });

  it("ignores the transitions of an earlier attempt", () => {
    const view = task("implement", [["implement", "implementer started", 5]], [agent(1, "implementer", 5, "waiting")]);
    view.takenAt = at(5);
    view.transitions.unshift({ id: 0, issueNumber: ISSUE, from: "qa", to: "stuck", reason: "old", at: "2025-12-31T10:00:00.000Z" });
    expect(summary(view)[0]).toEqual(["implement-0", "Реализация", 1, "waiting", null]);
  });
});
