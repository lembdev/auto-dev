import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Digest } from "./Digest.js";

describe("Digest", () => {
  it("lists Requests, finished Tasks and dead ends since the previous visit", () => {
    const onOpenRequest = vi.fn();
    render(
      <Digest
        since="2026-01-01T08:14:00.000Z"
        onOpenRequest={onOpenRequest}
        digest={{
          since: "2026-01-01T08:14:00.000Z",
          requests: [{ id: 1, issueNumber: 138, title: "Валидация дат вязки", createdAt: "2026-01-01T09:41:00.000Z", open: true, question: "Как валидировать?" }],
          done: [{ issueNumber: 137, title: "Фото котят", pullNumber: 149, pullUrl: "https://github.com/acme/product/pull/149", at: "2026-01-01T10:00:00.000Z" }],
          stuck: [{ issueNumber: 129, title: "Синхронизация с WCF", reason: "QA Круги исчерпаны", at: "2026-01-01T10:30:00.000Z" }],
        }}
      />,
    );
    expect(screen.getByTestId("digest-requests")).toHaveTextContent("#138 Валидация дат вязки");
    expect(screen.getByTestId("digest-done")).toHaveTextContent("#137 Фото котят (PR #149 влит)");
    expect(screen.getByTestId("digest-stuck")).toHaveTextContent("#129 Синхронизация с WCF");
    fireEvent.click(screen.getByRole("button", { name: "#138 Валидация дат вязки" }));
    expect(onOpenRequest).toHaveBeenCalledWith(138);
  });

  it("explains the first visit and says 'нет' for empty rows", () => {
    const { rerender } = render(<Digest since={null} digest={undefined} onOpenRequest={vi.fn()} />);
    expect(screen.getByText(/Это первый визит/)).toBeInTheDocument();
    rerender(<Digest since="2026-01-01T08:14:00.000Z" digest={{ since: "2026-01-01T08:14:00.000Z", requests: [], done: [], stuck: [] }} onOpenRequest={vi.fn()} />);
    expect(screen.getByTestId("digest-requests")).toHaveTextContent("Запросы к человеку: нет");
  });
});
