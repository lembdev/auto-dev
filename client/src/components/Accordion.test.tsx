import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Accordion } from "./ui.js";

describe("Accordion", () => {
  afterEach(() => localStorage.clear());

  it("shows its counter and folds on a click on the title", () => {
    render(
      <Accordion title="Влито за сутки" count={4} data-testid="group">
        <p>содержимое</p>
      </Accordion>,
    );
    const group = screen.getByTestId("group");
    expect(group).toHaveAttribute("open");
    expect(group.querySelector("summary")).toHaveTextContent("Влито за сутки4");
    fireEvent.click(screen.getByText("Влито за сутки"));
    expect(group).not.toHaveAttribute("open");
  });

  it("remembers a folded group in the browser", () => {
    const { unmount } = render(
      <Accordion title="Готовые" count={2} storageKey="auto-dev.section.ready" data-testid="group">
        <p>содержимое</p>
      </Accordion>,
    );
    fireEvent.click(screen.getByText("Готовые"));
    expect(localStorage.getItem("auto-dev.section.ready")).toBe("closed");
    unmount();
    render(
      <Accordion title="Готовые" count={2} storageKey="auto-dev.section.ready" data-testid="group">
        <p>содержимое</p>
      </Accordion>,
    );
    expect(screen.getByTestId("group")).not.toHaveAttribute("open");
  });
});
