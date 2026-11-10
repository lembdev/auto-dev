import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HumanRequestId, IssueNumber, PullNumber } from "../../../src/ids.js";
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
          requests: [{ id: 1 as HumanRequestId, issueNumber: 138 as IssueNumber, title: "Валидация дат вязки", createdAt: "2026-01-01T09:41:00.000Z", open: true, question: "Как валидировать?" }],
          done: [{ issueNumber: 137 as IssueNumber, title: "Фото котят", pullNumber: 149 as PullNumber, pullUrl: "https://github.com/acme/product/pull/149", at: "2026-01-01T10:00:00.000Z" }],
          stuck: [{ issueNumber: 129 as IssueNumber, title: "Синхронизация с WCF", reason: "QA Круги исчерпаны", at: "2026-01-01T10:30:00.000Z" }],
        }}
      />,
    );
    expect(screen.getByTestId("digest-requests")).toHaveTextContent("#138 Валидация дат вязки");
    expect(screen.getByTestId("digest-done")).toHaveTextContent("#137 Фото котят (PR #149 влит)");
    // Every Task on a line of its own, the group open with its counter.
    expect(screen.getByTestId("digest-done").querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByTestId("digest-done")).toHaveAttribute("open");
    expect(screen.getByTestId("digest-done").querySelector("[data-testid=accordion-count]")).toHaveTextContent("1");
    expect(screen.getByTestId("digest-stuck")).toHaveTextContent("#129 Синхронизация с WCF");
    fireEvent.click(screen.getByRole("button", { name: "#138 Валидация дат вязки" }));
    expect(onOpenRequest).toHaveBeenCalledWith(138);
  });

  it("explains the first visit and says 'нет' for empty rows", () => {
    const { rerender } = render(<Digest since={null} digest={undefined} onOpenRequest={vi.fn()} />);
    expect(screen.getByText(/Это первый визит/)).toBeInTheDocument();
    rerender(<Digest since="2026-01-01T08:14:00.000Z" digest={{ since: "2026-01-01T08:14:00.000Z", requests: [], done: [], stuck: [] }} onOpenRequest={vi.fn()} />);
    expect(screen.getByTestId("digest-requests")).toHaveTextContent("Запросы к человеку0нет");
    expect(screen.getByTestId("digest-requests")).not.toHaveAttribute("open");
  });

  it("puts each finished Task on its own line and opens a group once the digest arrives", () => {
    const since = "2026-01-01T08:14:00.000Z";
    const { rerender } = render(<Digest since={since} digest={undefined} onOpenRequest={vi.fn()} />);
    expect(screen.getByTestId("digest-done")).not.toHaveAttribute("open");
    const done = [137, 140, 141].map((n) => ({ issueNumber: n as IssueNumber, title: `Задача ${n}`, pullNumber: null, pullUrl: null, at: "2026-01-01T10:00:00.000Z" }));
    rerender(<Digest since={since} digest={{ since, requests: [], done, stuck: [] }} onOpenRequest={vi.fn()} />);
    const group = screen.getByTestId("digest-done");
    expect(group).toHaveAttribute("open");
    expect([...group.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["#137 Задача 137", "#140 Задача 140", "#141 Задача 141"]);
    expect(group.querySelector("[data-testid=accordion-count]")).toHaveTextContent("3");
  });
});
