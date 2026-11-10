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
  claudeVersion: { current: "2.1.318", lastKnownGood: "2.1.318", status: "ok", error: null, rollbackCommand: null, checkedAt: "2026-01-01T11:59:00.000Z" },
  blocker: null,
  canStartTurn: true,
  slots: { used: 1, max: 2 },
  product: { fullName: "acme/product", htmlUrl: "https://github.com/acme/product" },
  version: "0.1.0",
  update: { current: "0.1.0", latest: "0.1.0", latestUrl: null, available: false, checkedAt: "2026-01-01T11:00:00.000Z", phase: "idle", phaseSince: null },
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

  it("shows a window whose reset has passed as reset instead of its old percentage", () => {
    renderHeader(installation({ limits: { fiveHour: { usedPercent: 88, resetsAt: "2026-01-01T11:30:00.000Z", at: "2026-01-01T09:00:00.000Z", source: "event" }, sevenDay: null } }));
    expect(screen.getByTestId("limit-5 ч")).toHaveAttribute("data-level", "reset");
    expect(screen.getByTestId("limit-5 ч")).toHaveTextContent("сброшен");
    expect(screen.getByTestId("limit-5 ч")).not.toHaveTextContent("88");
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

  it("shows a failed claude update with the rollback command and asks for another check on click", () => {
    const onRecheck = vi.fn();
    render(
      <Header
        installation={installation({
          blocker: "claude_version",
          canStartTurn: false,
          claudeVersion: { current: "2.2.0", lastKnownGood: "2.1.318", status: "failed", error: "process exited with code 1", rollbackCommand: "claude install 2.1.318", checkedAt: "2026-01-01T11:59:00.000Z" },
        })}
        mode="development"
        onMode={vi.fn()}
        page="main"
        onPage={vi.fn()}
        onPause={vi.fn()}
        pausePending={false}
        onRecheck={onRecheck}
        recheckPending={false}
        connected
        now={NOW}
        onLogout={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("claude-version-banner");
    expect(banner).toHaveTextContent("claude 2.2.0 не прошёл проверку: process exited with code 1");
    expect(banner).toHaveTextContent("живые Сессии продолжают работу");
    expect(banner).toHaveTextContent("claude install 2.1.318");
    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("tells the human to store a new token when the Pause comes from a rejected OAuth token", () => {
    const onPage = vi.fn();
    render(
      <Header
        installation={installation({ paused: true, pause: { source: "token", reason: "the Claude OAuth token was rejected", since: "2026-01-01T11:00:00.000Z" }, blocker: "paused", canStartTurn: false })}
        mode="development"
        onMode={vi.fn()}
        page="main"
        onPage={onPage}
        onPause={vi.fn()}
        pausePending={false}
        connected
        now={NOW}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByTestId("token-banner")).toHaveTextContent("Токен подписки истёк");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Обновить токен в Настройках" }));
    expect(onPage).toHaveBeenCalledWith("settings");
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
  describe("new release", () => {
    const UPDATE = { current: "0.1.0", latest: "0.2.0", latestUrl: "https://github.com/lembdev/auto-dev/releases/tag/v0.2.0", available: true, checkedAt: "2026-01-01T11:00:00.000Z", phase: "idle", phaseSince: null } as const;
    const renderWith = (view: InstallationResponse, extra: { onUpdate?: () => void; updateError?: string } = {}) =>
      render(<Header installation={view} mode="development" onMode={vi.fn()} page="main" onPage={vi.fn()} onPause={vi.fn()} pausePending={false} connected now={NOW} onLogout={vi.fn()} {...extra} />);

    it("shows no banner while the running version is the latest", () => {
      renderHeader(installation());
      expect(screen.queryByTestId("update-banner")).toBeNull();
    });

    it("offers the newer version with an Обновить button that starts the update", () => {
      const onUpdate = vi.fn();
      renderWith(installation({ update: UPDATE }), { onUpdate });
      const banner = screen.getByTestId("update-banner");
      expect(banner).toHaveTextContent("Доступна версия 0.2.0 (сейчас 0.1.0)");
      expect(screen.getByRole("link", { name: "0.2.0" })).toHaveAttribute("href", UPDATE.latestUrl);
      fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });

    it("tells why the update did not start", () => {
      renderWith(installation({ update: UPDATE }), { onUpdate: vi.fn(), updateError: "sudo: a password is required" });
      expect(screen.getByTestId("update-banner")).toHaveTextContent("Не удалось запустить обновление: sudo: a password is required");
    });

    it("follows an update under way instead of offering another one", () => {
      renderWith(installation({ update: { ...UPDATE, phase: "preparing", phaseSince: "2026-01-01T11:58:00.000Z" } }), { onUpdate: vi.fn() });
      expect(screen.getByTestId("update-banner")).toHaveTextContent("Обновление до 0.2.0: пауза, ждём окончания текущих Ходов");
      expect(screen.queryByRole("button", { name: "Обновить" })).toBeNull();
    });
  });
});
