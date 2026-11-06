import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SetupStatus, SetupStepId } from "../../../src/server/api-types.js";
import { SetupWizard, type SetupWizardProps } from "./SetupWizard.js";

const ORDER: SetupStepId[] = ["password", "repository", "access", "oauth", "smoke", "clone"];

const statusAt = (current: SetupStepId | "done", repo: string | null = "acme/product"): SetupStatus => {
  const index = current === "done" ? ORDER.length : ORDER.indexOf(current);
  return {
    required: current !== "done",
    current,
    steps: Object.fromEntries(ORDER.map((id, position) => [id, position < index])) as SetupStatus["steps"],
    passwordSet: index > 0,
    repo: index > 1 ? repo : null,
    repoPath: "/var/lib/auto-dev/repo",
  };
};

const handlers = () => ({
  onPassword: vi.fn(),
  onRepository: vi.fn(),
  onCheckAccess: vi.fn(),
  onOauth: vi.fn(),
  onSmoke: vi.fn(),
  onClone: vi.fn(),
  onFinish: vi.fn(),
});

const renderWizard = (status: SetupStatus, overrides: Partial<SetupWizardProps> = {}) => {
  const fns = handlers();
  const view = render(<SetupWizard status={status} busy={false} error={null} access={null} smoke={null} {...fns} {...overrides} />);
  return { ...view, ...fns };
};

const type = (name: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name }) as HTMLInputElement, { target: { value } });
const typePassword = (name: string, value: string) => fireEvent.change(document.querySelector(`input[name="${name}"]`) as HTMLInputElement, { target: { value } });

describe("SetupWizard", () => {
  it("opens on the current step of the status and marks the done ones", () => {
    renderWizard(statusAt("oauth"));
    expect(screen.getByTestId("setup-wizard")).toHaveAttribute("data-step", "oauth");
    expect(screen.getByTestId("step-password")).toHaveAttribute("data-done", "true");
    expect(screen.getByTestId("step-access")).toHaveAttribute("data-done", "true");
    expect(screen.getByTestId("step-oauth")).toHaveAttribute("data-done", "false");
    expect(screen.getByTestId("step-oauth")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("claude setup-token")).toBeInTheDocument();
  });

  it("saves the password only when both fields match", () => {
    const { onPassword } = renderWizard(statusAt("password"));
    typePassword("password", "correct horse");
    typePassword("repeat", "wrong horse");
    expect(screen.getByText("Пароли не совпадают.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить пароль" })).toBeDisabled();
    typePassword("repeat", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить пароль" }));
    expect(onPassword).toHaveBeenCalledWith("correct horse");
  });

  it("sends the repository and the token, trimmed", () => {
    const { onRepository } = renderWizard(statusAt("repository"));
    expect(screen.getByText(/Issues: write/)).toBeInTheDocument();
    type("Репозиторий (owner/name)", " acme/product ");
    typePassword("token", "github_pat_x ");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onRepository).toHaveBeenCalledWith({ repo: "acme/product", token: "github_pat_x" });
  });

  it("runs the access check, shows the missing permissions and lets the human go back to the token", () => {
    const { onCheckAccess, rerender, onRepository } = renderWizard(statusAt("access"));
    fireEvent.click(screen.getByRole("button", { name: "Проверить доступ" }));
    expect(onCheckAccess).toHaveBeenCalled();
    const fns = handlers();
    rerender(
      <SetupWizard
        status={statusAt("access")}
        busy={false}
        error={null}
        smoke={null}
        access={{
          ok: false,
          error: "the token lacks Issues: write on acme/product",
          missing: ["issuesWrite"],
          access: { fullName: "acme/product", defaultBranch: "main", permissions: { metadataRead: true, contentsWrite: true, issuesWrite: false, pullRequestsWrite: true } },
          status: statusAt("access"),
        }}
        {...fns}
        onRepository={onRepository}
      />,
    );
    expect(screen.getByTestId("access-result")).toHaveTextContent("the token lacks Issues: write");
    expect(screen.getByTestId("permission-issuesWrite")).toHaveAttribute("data-granted", "false");
    expect(screen.getByTestId("permission-contentsWrite")).toHaveAttribute("data-granted", "true");
    fireEvent.click(screen.getByRole("button", { name: "Изменить репозиторий или токен" }));
    expect(screen.getByTestId("setup-wizard")).toHaveAttribute("data-step", "repository");
    expect((screen.getByRole("textbox", { name: "Репозиторий (owner/name)" }) as HTMLInputElement).value).toBe("acme/product");
  });

  it("shows the smoke query verdict and does not move on by itself after a failure", () => {
    const { onSmoke, rerender } = renderWizard(statusAt("smoke"));
    fireEvent.click(screen.getByRole("button", { name: "Запустить проверку" }));
    expect(onSmoke).toHaveBeenCalled();
    rerender(
      <SetupWizard
        status={statusAt("smoke")}
        busy={false}
        error={null}
        access={null}
        smoke={{ ok: false, error: "authentication_failed", claudeVersion: null, model: null, status: statusAt("smoke") }}
        {...handlers()}
      />,
    );
    expect(screen.getByTestId("smoke-result")).toHaveTextContent("authentication_failed");
    expect(screen.getByTestId("setup-wizard")).toHaveAttribute("data-step", "smoke");
    fireEvent.click(screen.getByRole("button", { name: "Изменить токен" }));
    expect(screen.getByTestId("setup-wizard")).toHaveAttribute("data-step", "oauth");
  });

  it("clones the Product and offers the dashboard when done", () => {
    const { onClone, rerender } = renderWizard(statusAt("clone"));
    expect(screen.getByText("/var/lib/auto-dev/repo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Клонировать" }));
    expect(onClone).toHaveBeenCalled();
    const fns = handlers();
    rerender(<SetupWizard status={statusAt("done")} busy={false} error={null} access={null} smoke={null} {...fns} />);
    expect(screen.getByRole("heading", { name: "Готово" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Открыть панель" }));
    expect(fns.onFinish).toHaveBeenCalled();
  });

  it("shows a server error above the step", () => {
    renderWizard(statusAt("repository"), { error: 'repository must be "owner/name"' });
    expect(screen.getByRole("alert")).toHaveTextContent('repository must be "owner/name"');
  });
});
