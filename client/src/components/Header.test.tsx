import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InstallationResponse } from "../../../src/server/api-types.js";
import { Header } from "./Header.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

const installation = (overrides: Partial<InstallationResponse> = {}): InstallationResponse => ({
  paused: false,
  pause: null,
  atLimit: null,
  limits: {
    fiveHour: { usedPercent: 72, resetsAt: "2026-01-01T14:30:00.000Z", at: "2026-01-01T11:55:00.000Z", source: "statusline" },
    sevenDay: { usedPercent: 41, resetsAt: "2026-01-03T09:00:00.000Z", at: "2026-01-01T11:55:00.000Z", source: "statusline" },
  },
  prearm: { enabled: true, thresholdPercent: 95, active: false },
  disk: null,
  blocker: null,
  canStartTurn: true,
  slots: { used: 1, max: 2 },
  product: { fullName: "acme/product", htmlUrl: "https://github.com/acme/product" },
  version: "0.1.0",
  ...overrides,
});

const renderHeader = (view: InstallationResponse | undefined, onPause = vi.fn()) =>
  render(<Header installation={view} mode="development" onMode={vi.fn()} page="main" onPage={vi.fn()} onPause={onPause} pausePending={false} connected now={NOW} onLogout={vi.fn()} />);

describe("Header", () => {
  it("shows the Product, both limits with their reset time and level, and the Slots", () => {
    renderHeader(installation());
    expect(screen.getByTestId("product")).toHaveTextContent("acme/product");
    const fiveHour = screen.getByTestId("limit-5 ч");
    expect(fiveHour).toHaveTextContent("72 %");
    expect(fiveHour).toHaveAttribute("data-level", "warn");
    const sevenDay = screen.getByTestId("limit-7 дн");
    expect(sevenDay).toHaveTextContent("41 %");
    expect(sevenDay).toHaveAttribute("data-level", "ok");
    expect(sevenDay).toHaveTextContent("сб");
    expect(screen.getByTestId("slots")).toHaveTextContent("Слоты 1 / 2");
  });

  it("colours a limit past 85 percent as danger and shows missing readings", () => {
    renderHeader(installation({ limits: { fiveHour: { usedPercent: 91.4, resetsAt: null, at: "2026-01-01T11:55:00.000Z", source: "event" }, sevenDay: null } }));
    expect(screen.getByTestId("limit-5 ч")).toHaveAttribute("data-level", "danger");
    expect(screen.getByTestId("limit-5 ч")).toHaveTextContent("91 %");
    expect(screen.getByTestId("limit-7 дн")).toHaveAttribute("data-level", "none");
  });

  it("toggles the Pause and explains it in a banner", () => {
    const onPause = vi.fn();
    const { rerender } = render(
      <Header installation={installation()} mode="development" onMode={vi.fn()} page="main" onPage={vi.fn()} onPause={onPause} pausePending={false} connected now={NOW} onLogout={vi.fn()} />,
    );
    const toggle = screen.getByRole("switch", { name: "Пауза" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onPause).toHaveBeenCalledWith(true);

    rerender(
      <Header
        installation={installation({ paused: true, pause: { source: "human", reason: "paused from the UI", since: "2026-01-01T11:00:00.000Z" }, blocker: "paused", canStartTurn: false })}
        mode="development"
        onMode={vi.fn()}
        page="main"
        onPage={vi.fn()}
        onPause={onPause}
        pausePending={false}
        connected
        now={NOW}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch", { name: "Пауза: вкл" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("status")).toHaveTextContent("включена человеком: paused from the UI");
    fireEvent.click(screen.getByRole("switch", { name: "Пауза: вкл" }));
    expect(onPause).toHaveBeenLastCalledWith(false);
  });

  it("opens the statistics page from the header and marks it current", () => {
    const onPage = vi.fn();
    const { rerender } = render(
      <Header installation={installation()} mode="development" onMode={vi.fn()} page="main" onPage={onPage} onPause={vi.fn()} pausePending={false} connected now={NOW} onLogout={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Статистика" }));
    expect(onPage).toHaveBeenCalledWith("stats");
    rerender(
      <Header installation={installation()} mode="development" onMode={vi.fn()} page="stats" onPage={onPage} onPause={vi.fn()} pausePending={false} connected now={NOW} onLogout={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Статистика" })).toHaveAttribute("aria-current", "page");
  });
});
