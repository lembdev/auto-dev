import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlannerResponse } from "../../../src/server/api-types.js";
import { emptyFeed } from "../feed.js";
import { PlanningScreenView, type PlanningScreenViewProps } from "./PlanningScreen.js";

const AGENT = { id: 9, role: "planner" as const, state: "running" as const, lastTurnAt: null, createdAt: "2026-01-01T10:00:00.000Z" };

const planner = (overrides: Partial<PlannerResponse> = {}): PlannerResponse => ({
  status: "none",
  open: false,
  canResume: false,
  agent: null,
  sessionId: null,
  queue: [],
  ...overrides,
});

const renderScreen = (view: PlannerResponse | null, overrides: Partial<PlanningScreenViewProps> = {}) => {
  const props: PlanningScreenViewProps = {
    planner: view,
    loadError: null,
    onStart: vi.fn(),
    startPending: false,
    startError: null,
    onFinish: vi.fn(),
    finishPending: false,
    onInterrupt: vi.fn(),
    interruptPending: false,
    actionError: null,
    feed: emptyFeed(),
    feedStatus: "live",
    feedError: null,
    dialogueSlot: <div data-testid="dialogue-slot" />,
    ...overrides,
  };
  render(<PlanningScreenView {...props} />);
  return props;
};

describe("PlanningScreenView", () => {
  it("offers to continue the last Session or start a new one, with the first message", () => {
    const props = renderScreen(planner({ status: "stopped", canResume: true, agent: { ...AGENT, state: "stopped" }, sessionId: "s-1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Первое сообщение Планировщику" }), { target: { value: "  Экспорт в CSV  " } });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить прошлую" }));
    expect(props.onStart).toHaveBeenCalledWith("resume", "Экспорт в CSV");
    fireEvent.click(screen.getByRole("button", { name: "Начать новую" }));
    expect(props.onStart).toHaveBeenLastCalledWith("new", "Экспорт в CSV");
    expect(screen.queryByTestId("agent-feed")).toBeNull();
  });

  it("disables continuing when there is no previous Session", () => {
    const props = renderScreen(planner());
    const resume = screen.getByRole("button", { name: "Продолжить прошлую" });
    expect(resume).toBeDisabled();
    fireEvent.click(resume);
    expect(props.onStart).not.toHaveBeenCalled();
    expect(screen.getByText("Прошлой Сессии нет")).toBeInTheDocument();
  });

  it("shows why the start was refused", () => {
    renderScreen(planner(), { startError: "Планировщик уже запущен" });
    expect(screen.getByRole("alert")).toHaveTextContent("Планировщик уже запущен");
  });

  it("an open Session shows the chat of the Agent panel and the finish button", () => {
    const props = renderScreen(planner({ status: "running", open: true, canResume: true, agent: AGENT, sessionId: "s-1" }));
    expect(screen.getByTestId("agent-feed")).toBeInTheDocument();
    expect(screen.getByTestId("dialogue-slot")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Начать новую" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Завершить планирование" }));
    expect(props.onFinish).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Остановить ход" }));
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("offers no stop between Turns and blocks a second finish while one is pending", () => {
    renderScreen(planner({ status: "idle", open: true, canResume: true, agent: { ...AGENT, state: "idle" }, sessionId: "s-1" }), { finishPending: true });
    expect(screen.queryByRole("button", { name: "Остановить ход" })).toBeNull();
    expect(screen.getByRole("button", { name: "Завершить планирование" })).toBeDisabled();
  });
});
