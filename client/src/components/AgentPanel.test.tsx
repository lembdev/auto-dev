import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IssueNumber, PullNumber } from "../../../src/ids.js";
import type { TaskView } from "../../../src/server/api-types.js";
import { emptyFeed } from "../feed.js";
import { AgentPanelView, type AgentPanelViewProps } from "./AgentPanel.js";

const task = (overrides: Partial<TaskView> = {}): TaskView => ({
  issueNumber: 138 as IssueNumber,
  title: "Валидация дат вязки",
  milestone: null,
  stage: "implement",
  round: 0,
  attempt: 1,
  pullNumber: 147 as PullNumber,
  branch: "worktree-issue-138",
  worktreePath: "/var/lib/auto-dev/repo/.claude/worktrees/issue-138",
  takenAt: "2026-01-01T09:50:00.000Z",
  updatedAt: "2026-01-01T11:00:00.000Z",
  htmlUrl: "https://github.com/acme/product/issues/138",
  pullUrl: "https://github.com/acme/product/pull/147",
  agent: { id: 5, role: "implementer", state: "running", lastTurnAt: null, createdAt: "2026-01-01T10:00:00.000Z" },
  transitions: [],
  request: null,
  ...overrides,
});

const renderPanel = (view: TaskView, overrides: Partial<AgentPanelViewProps> = {}) => {
  const props: AgentPanelViewProps = {
    task: view,
    maxQaRounds: 3,
    answering: false,
    onClose: vi.fn(),
    feed: emptyFeed(),
    feedStatus: "live",
    feedError: null,
    onInterrupt: vi.fn(),
    interruptPending: false,
    interruptError: null,
    onCancel: vi.fn(),
    cancelPending: false,
    cancelError: null,
    ...overrides,
  };
  render(<AgentPanelView {...props} />);
  return props;
};

describe("AgentPanelView", () => {
  it("offers to stop the Turn only while the Agent is running", () => {
    const props = renderPanel(task());
    fireEvent.click(screen.getByRole("button", { name: "Остановить ход" }));
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
  });

  it.each(["idle", "waiting", "stopped"] as const)("hides the stop button for a %s Agent", (state) => {
    renderPanel(task({ agent: { id: 5, role: "implementer", state, lastTurnAt: null, createdAt: "2026-01-01T10:00:00.000Z" } }));
    expect(screen.queryByRole("button", { name: "Остановить ход" })).toBeNull();
    expect(screen.getByRole("button", { name: "Отменить задачу" })).toBeInTheDocument();
  });

  it("cancels the Task only after a confirmation inside the panel", () => {
    const props = renderPanel(task());
    fireEvent.click(screen.getByRole("button", { name: "Отменить задачу" }));
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("Отменить Задачу #138? Issue будет закрыта без влитого PR");
    fireEvent.click(screen.getByRole("button", { name: "Нет" }));
    expect(screen.queryByTestId("cancel-confirm")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Отменить задачу" }));
    fireEvent.click(screen.getByRole("button", { name: "Да, отменить" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the errors of the actions and the slots of the Request and the Dialogue", () => {
    renderPanel(task(), {
      interruptError: "the Agent is idle, not running a Turn",
      requestSlot: <div data-testid="request-slot">Запрос</div>,
      dialogueSlot: <div data-testid="dialogue-slot">Диалог</div>,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Не остановлено: the Agent is idle, not running a Turn");
    expect(screen.getByTestId("request-slot")).toBeInTheDocument();
    expect(screen.getByTestId("dialogue-slot")).toBeInTheDocument();
  });
});
