import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeadEndQuestionBoxView, type DeadEndQuestionBoxViewProps } from "./DeadEndQuestionBox.js";

const renderBox = (overrides: Partial<DeadEndQuestionBoxViewProps> = {}) => {
  const props: DeadEndQuestionBoxViewProps = { onAsk: vi.fn(), sending: false, answering: false, error: null, ...overrides };
  const view = render(<DeadEndQuestionBoxView {...props} />);
  return { props, view };
};

describe("DeadEndQuestionBoxView", () => {
  it("asks with the trimmed text and clears the field only once the question is sent", () => {
    const { props } = renderBox();
    const field = screen.getByRole("textbox", { name: "Вопрос Агенту" });
    const ask = screen.getByRole("button", { name: "Спросить" });
    expect(ask).toBeDisabled();

    fireEvent.change(field, { target: { value: "  Почему не запушил?  " } });
    fireEvent.click(ask);
    expect(props.onAsk).toHaveBeenCalledTimes(1);
    const [text, onSent] = vi.mocked(props.onAsk).mock.calls[0]!;
    expect(text).toBe("Почему не запушил?");
    expect(field).toHaveValue("  Почему не запушил?  ");
    act(() => onSent());
    expect(screen.getByRole("textbox", { name: "Вопрос Агенту" })).toHaveValue("");
  });

  it("asks on Ctrl+Enter", () => {
    const { props } = renderBox();
    const field = screen.getByRole("textbox", { name: "Вопрос Агенту" });
    fireEvent.change(field, { target: { value: "Что в worktree?" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(props.onAsk).toHaveBeenCalledWith("Что в worktree?", expect.any(Function));
  });

  it("shows the sending and the answering state and asks nothing more meanwhile", () => {
    const { props, view } = renderBox({ sending: true });
    expect(screen.getByRole("status")).toHaveTextContent("отправляется…");
    fireEvent.change(screen.getByRole("textbox", { name: "Вопрос Агенту" }), { target: { value: "Ещё вопрос" } });
    expect(screen.getByRole("button", { name: "Спросить" })).toBeDisabled();

    view.rerender(<DeadEndQuestionBoxView {...props} sending={false} answering />);
    expect(screen.getByRole("status")).toHaveTextContent("Агент отвечает…");
    expect(screen.getByRole("button", { name: "Спросить" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Вопрос Агенту" }), { key: "Enter", metaKey: true });
    expect(props.onAsk).not.toHaveBeenCalled();
  });

  it("shows why the question was not sent", () => {
    renderBox({ error: "новые Ходы сейчас не стартуют: Установка на Паузе" });
    expect(screen.getByRole("alert")).toHaveTextContent("Вопрос не отправлен: новые Ходы сейчас не стартуют: Установка на Паузе");
  });
});
