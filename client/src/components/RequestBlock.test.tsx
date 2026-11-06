import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentId, CommentId, HumanRequestId } from "../../../src/ids.js";
import type { RequestView } from "../../../src/server/api-types.js";
import { RequestBlock } from "./RequestBlock.js";

const request = (overrides: Partial<RequestView> = {}): RequestView => ({
  id: 4 as HumanRequestId,
  agentId: 5 as AgentId,
  commentId: 900 as CommentId,
  commentUrl: "https://github.com/acme/product/issues/138#issuecomment-900",
  createdAt: "2026-01-01T10:00:00.000Z",
  question: "Which colour for the button?",
  options: ["red", "blue"],
  ...overrides,
});

describe("RequestBlock", () => {
  it("shows the question, fills the field from an option button and answers with the text of the field", () => {
    const onAnswer = vi.fn();
    render(<RequestBlock request={request()} autoFocus={false} onAnswer={onAnswer} />);
    expect(screen.getByText("Which colour for the button?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "комментарий в issue" })).toHaveAttribute("href", "https://github.com/acme/product/issues/138#issuecomment-900");
    const answer = screen.getByRole("button", { name: "Ответить" });
    expect(answer).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "blue" }));
    const field = screen.getByRole("textbox", { name: "Ответ" });
    expect(field).toHaveValue("blue");
    fireEvent.change(field, { target: { value: "blue, but darker" } });
    fireEvent.click(answer);
    expect(onAnswer).toHaveBeenCalledWith("blue, but darker");
    expect(field).toHaveValue("");
  });

  it("sends on Ctrl+Enter and never an empty Answer", () => {
    const onAnswer = vi.fn();
    render(<RequestBlock request={request({ options: [], question: null, commentUrl: null })} autoFocus={true} onAnswer={onAnswer} />);
    expect(screen.getByText("текст Запроса в комментарии issue")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    const field = screen.getByRole("textbox", { name: "Ответ" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "go ahead" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(onAnswer).toHaveBeenCalledWith("go ahead");
  });
});
