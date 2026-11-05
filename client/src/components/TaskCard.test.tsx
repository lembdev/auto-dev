import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IssueNumber, MilestoneNumber, PullNumber } from "../../../src/ids.js";
import type { StuckTaskView, TaskView } from "../../../src/server/api-types.js";
import { StuckCard, TaskCard } from "./TaskCard.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

const task = (overrides: Partial<TaskView> = {}): TaskView => ({
  issueNumber: 138 as IssueNumber,
  title: "Валидация дат вязки",
  milestone: { number: 3 as MilestoneNumber, title: "v0.3 Родословные" },
  stage: "qa",
  round: 1,
  attempt: 1,
  pullNumber: 147 as PullNumber,
  branch: "worktree-issue-138",
  worktreePath: "/var/lib/auto-dev/repo/.claude/worktrees/issue-138",
  takenAt: "2026-01-01T09:50:00.000Z",
  updatedAt: "2026-01-01T11:00:00.000Z",
  htmlUrl: "https://github.com/acme/product/issues/138",
  pullUrl: "https://github.com/acme/product/pull/147",
  agent: { id: 5, role: "qa", state: "running", lastTurnAt: null, createdAt: "2026-01-01T10:00:00.000Z" },
  request: null,
  ...overrides,
});

const renderCard = (view: TaskView, handlers: { onOpen?: () => void; onAnswer?: () => void } = {}) =>
  render(<TaskCard task={view} maxQaRounds={3} now={NOW} selected={false} onOpen={handlers.onOpen ?? vi.fn()} onAnswer={handlers.onAnswer ?? vi.fn()} />);

describe("TaskCard", () => {
  it("shows the number, the title, the milestone, the QA round, the Agent badge, the PR and the time", () => {
    const onOpen = vi.fn();
    renderCard(task(), { onOpen });
    const card = screen.getByTestId("task-138");
    expect(card).toHaveTextContent("#138 Валидация дат вязки");
    expect(card).toHaveTextContent("v0.3 Родословные");
    expect(card).toHaveTextContent("QA · Круг 2 из 3");
    expect(card).toHaveTextContent("работает");
    expect(screen.getByRole("link", { name: "PR #147" })).toHaveAttribute("href", "https://github.com/acme/product/pull/147");
    expect(card).toHaveTextContent("2 ч 10 мин");
    expect(card).toHaveAttribute("data-waiting", "false");
    expect(screen.queryByRole("button", { name: "Ответить" })).toBeNull();
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 138 }));
  });

  it("highlights a waiting Task, shows the first line of the Request and offers to answer", () => {
    const onOpen = vi.fn();
    const onAnswer = vi.fn();
    const waiting = task({
      stage: "implement",
      agent: { id: 5, role: "implementer", state: "waiting", lastTurnAt: "2026-01-01T11:41:00.000Z", createdAt: "2026-01-01T10:00:00.000Z" },
      request: {
        id: 9,
        agentId: 5,
        commentId: 2211,
        commentUrl: "https://github.com/acme/product/issues/138#issuecomment-2211",
        createdAt: "2026-01-01T11:41:00.000Z",
        question: "Как валидировать даты раньше рождения?\nВ импорте 14 таких записей.",
        options: ["Ошибка", "Предупреждение"],
      },
    });
    renderCard(waiting, { onOpen, onAnswer });
    const card = screen.getByTestId("task-138");
    expect(card).toHaveAttribute("data-waiting", "true");
    expect(card).toHaveTextContent("Реализация");
    expect(card).toHaveTextContent("ждёт человека");
    expect(screen.getByTestId("request-line")).toHaveTextContent("Как валидировать даты раньше рождения?");
    expect(screen.getByTestId("request-line")).not.toHaveTextContent("14 таких записей");
    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 138 }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("marks a just taken Task without an Agent and a stopped one", () => {
    renderCard(task({ stage: "taken", agent: null, pullNumber: null, pullUrl: null }));
    expect(screen.getByTestId("task-138")).toHaveTextContent("Взята");
    expect(screen.getByTestId("task-138")).toHaveTextContent("запускается");
    expect(screen.queryByText(/PR #/)).toBeNull();
  });
});

describe("StuckCard", () => {
  it("shows the reason and the ready-for-human badge", () => {
    const stuck: StuckTaskView = { ...task({ stage: "stuck", agent: { id: 5, role: "qa", state: "stopped", lastTurnAt: null, createdAt: "2026-01-01T10:00:00.000Z" } }), reason: "QA Круги исчерпаны (3 из 3)", stuckAt: "2026-01-01T11:30:00.000Z" };
    render(<StuckCard task={stuck} now={NOW} />);
    const card = screen.getByTestId("stuck-138");
    expect(card).toHaveTextContent("ready-for-human");
    expect(screen.getByTestId("stuck-reason")).toHaveTextContent("QA Круги исчерпаны (3 из 3)");
    expect(card).toHaveTextContent("30 мин назад");
  });
});
