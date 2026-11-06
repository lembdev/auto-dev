import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentId, HumanRequestId, IssueNumber, PendingMessageId } from "../../../src/ids.js";
import type { DialogueMessageView } from "../../../src/server/api-types.js";
import { ackLabel, DialogueBoxView, type DialogueBoxViewProps } from "./DialogueBox.js";

const message = (overrides: Partial<DialogueMessageView> = {}): DialogueMessageView => ({
  id: 11 as PendingMessageId,
  issueNumber: 138 as IssueNumber,
  agentId: 5 as AgentId,
  source: "ui",
  clientId: "tab-a",
  seq: 3,
  text: "also handle the empty list",
  createdAt: "2026-01-01T10:00:00.000Z",
  ...overrides,
});

const renderBox = (overrides: Partial<DialogueBoxViewProps<PendingMessageId>> = {}) => {
  const props: DialogueBoxViewProps<PendingMessageId> = {
    queue: [],
    pending: [],
    lastAck: null,
    onSend: vi.fn(),
    onRemove: vi.fn(),
    removing: null,
    error: null,
    ...overrides,
  };
  render(<DialogueBoxView {...props} />);
  return props;
};

describe("DialogueBoxView", () => {
  it("sends the field and clears it; an empty field sends nothing", () => {
    const props = renderBox();
    expect(screen.queryByRole("list", { name: "Ещё не доставлено" })).toBeNull();
    const field = screen.getByRole("textbox", { name: "Сообщение Агенту" });
    const send = screen.getByRole("button", { name: "Отправить" });
    expect(send).toBeDisabled();
    fireEvent.change(field, { target: { value: "check the footer too" } });
    fireEvent.click(send);
    expect(props.onSend).toHaveBeenCalledWith("check the footer too");
    expect(field).toHaveValue("");
  });

  it("lists the unconfirmed frames and the queued lines, and removes a queued line on its button", () => {
    const props = renderBox({
      pending: [{ kind: "dialogue", issueNumber: 138 as IssueNumber, seq: 4, text: "on its way", sentAt: null }],
      queue: [message(), message({ id: 12 as PendingMessageId, source: "github", text: "from bob" })],
    });
    const list = screen.getByRole("list", { name: "Ещё не доставлено" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("отправляется…");
    expect(items[0]).toHaveTextContent("on its way");
    expect(items[1]).toHaveTextContent("ждёт конца Хода");
    expect(items[2]).toHaveTextContent("из GitHub");
    expect(items[2]).toHaveTextContent("from bob");
    fireEvent.click(screen.getByRole("button", { name: "удалить сообщение 12" }));
    expect(props.onRemove).toHaveBeenCalledWith(12);
  });

  it("shows what the server said about the last frame", () => {
    renderBox({
      lastAck: {
        frame: { kind: "answer", issueNumber: 138 as IssueNumber, requestId: 4 as HumanRequestId, seq: 2, text: "blue", sentAt: null },
        ack: { type: "ack", clientId: "tab-a", seq: 2, watermark: 2, outcome: "rejected", reason: "already answered; the text joins the Dialogue" },
      },
      error: "the line already reached the Session",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Ответ отклонено: already answered; the text joins the Dialogue");
    expect(screen.getByRole("alert")).toHaveTextContent("Очередь Диалога: the line already reached the Session");
  });

  it("words every outcome", () => {
    const frame = { kind: "dialogue" as const, issueNumber: 1 as IssueNumber, seq: 1, text: "x", sentAt: null };
    const ack = (outcome: "applied" | "duplicate" | "rejected", reason: string | null = null) => ({ type: "ack" as const, clientId: "c", seq: 1, watermark: 1, outcome, reason });
    expect(ackLabel({ frame, ack: ack("applied") })).toBe("Сообщение принято");
    expect(ackLabel({ frame: { ...frame, kind: "answer", requestId: 2 as HumanRequestId }, ack: ack("applied") })).toBe("Ответ принят");
    expect(ackLabel({ frame, ack: ack("duplicate") })).toBe("Сообщение уже принято ранее");
    expect(ackLabel({ frame, ack: ack("rejected", "empty text") })).toBe("Сообщение отклонено: empty text");
  });
});
