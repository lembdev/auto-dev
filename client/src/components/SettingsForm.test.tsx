import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SettingsResponse } from "../../../src/server/api-types.js";
import { SettingsForm } from "./SettingsForm.js";

const settings = (overrides: Partial<SettingsResponse> = {}): SettingsResponse => ({
  maxParallelTasks: 2,
  prearmEnabled: true,
  maxQaRounds: 3,
  model: null,
  repo: "acme/product",
  secrets: { githubToken: true, oauthToken: true, password: true },
  ...overrides,
});

const renderForm = (view: SettingsResponse = settings(), overrides: Partial<Parameters<typeof SettingsForm>[0]> = {}) => {
  const onSave = vi.fn();
  render(<SettingsForm settings={view} busy={false} error={null} saved={null} onSave={onSave} onBack={vi.fn()} {...overrides} />);
  return { onSave };
};

describe("SettingsForm", () => {
  it("shows the numbers and saves only the changed ones", () => {
    const { onSave } = renderForm();
    const parallel = screen.getByRole("spinbutton", { name: /max_parallel_tasks/ }) as HTMLInputElement;
    expect(parallel.value).toBe("2");
    const save = screen.getAllByRole("button", { name: "Сохранить" })[0] as HTMLButtonElement;
    expect(save).toBeDisabled();
    fireEvent.change(parallel, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Пре-арм/ }));
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ maxParallelTasks: 4, prearmEnabled: false });
  });

  it("chooses the Agents' model from the subscription list, the CLI default sent as null", () => {
    const models = {
      error: null,
      models: [
        { value: "default", displayName: "Default (recommended)", description: "Sonnet · Efficient for routine tasks" },
        { value: "opus", displayName: "Opus", description: "Opus · Best for everyday, complex tasks" },
      ],
    };
    const { onSave } = renderForm(settings(), { models });
    const select = screen.getByRole("combobox", { name: "Модель Агентов" }) as HTMLSelectElement;
    expect(select.value).toBe("default");
    const save = select.closest("form")!.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(save).toBeDisabled();
    fireEvent.change(select, { target: { value: "opus" } });
    expect(screen.getByText("Opus · Best for everyday, complex tasks")).toBeInTheDocument();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ model: "opus" });
  });

  it("keeps a stored model selectable when the list could not be loaded", () => {
    const { onSave } = renderForm(settings({ model: "opus" }), { models: { models: [], error: "claude did not list the models" } });
    const select = screen.getByRole("combobox", { name: "Модель Агентов" }) as HTMLSelectElement;
    expect(select.value).toBe("opus");
    expect(screen.getByText(/Список моделей не получен/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves each secret on its own and clears the field", () => {
    const { onSave } = renderForm(settings({ secrets: { githubToken: true, oauthToken: false, password: true } }));
    const oauth = screen.getByTestId("secret-oauthToken");
    expect(oauth).toHaveTextContent("(не задан)");
    const input = oauth.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-oat01-new" } });
    fireEvent.click(oauth.querySelector("button") as HTMLButtonElement);
    expect(onSave).toHaveBeenCalledWith({ oauthToken: "sk-ant-oat01-new" });
    expect(input.value).toBe("");
  });

  it("explains a saved secret and shows server errors", () => {
    renderForm(settings(), { saved: { githubToken: "x" } });
    expect(screen.getByRole("status")).toHaveTextContent("перезапустятся по концу Хода");
    renderForm(settings(), { error: "the token lacks Contents: write on acme/product" });
    expect(screen.getByRole("alert")).toHaveTextContent("Contents: write");
  });
});
