import { useState, type FormEvent, type ReactNode } from "react";
import type { ModelsResponse, SettingsRequest, SettingsResponse } from "../../../src/server/api-types.js";
import { GithubTokenHelp } from "./GithubTokenHelp.js";
import { Banner, Button, Card, cx, INPUT as INPUT_BASE, SectionTitle } from "./ui.js";

export type SettingsFormProps = {
  settings: SettingsResponse;
  // Undefined while the CLI lists the models.
  models?: ModelsResponse | undefined;
  busy: boolean;
  error: string | null;
  // The last patch that went through, to tell the human what was saved.
  saved: SettingsRequest | null;
  onSave: (patch: SettingsRequest) => void;
  onBack: () => void;
};

const INPUT = cx(INPUT_BASE, "mt-1.5");
const LABEL = "block text-sm font-medium";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <SectionTitle className="mb-2.5">{title}</SectionTitle>
      <Card className="p-5">{children}</Card>
    </section>
  );
}

function SecretForm({ name, label, stored, hint, busy, type, onSave }: { name: string; label: string; stored: boolean; hint: ReactNode; busy: boolean; type: "password" | "text"; onSave: (value: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() === "") return;
    onSave(value);
    setValue("");
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-line pt-4 first:border-t-0 first:pt-0 [&+&]:mt-4" data-testid={`secret-${name}`}>
      <div className="flex gap-2 max-sm:flex-col sm:items-end">
        <label className={cx(LABEL, "flex-1")}>
          {label} <span className={cx("ml-1 text-xs font-normal", stored ? "text-ok" : "text-muted")}>{stored ? "(сохранён)" : "(не задан)"}</span>
          <input type={type} name={name} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className={INPUT} placeholder={stored ? "новое значение" : "значение"} />
        </label>
        <Button type="submit" variant="primary" disabled={busy || value.trim() === ""}>
          Сохранить
        </Button>
      </div>
      <div className="text-xs text-muted">{hint}</div>
    </form>
  );
}

const DEFAULT_MODEL = "default";

function ModelForm({ current, models, busy, onSave }: { current: string | null; models: ModelsResponse | undefined; busy: boolean; onSave: (model: string | null) => void }) {
  const stored = current ?? DEFAULT_MODEL;
  const [value, setValue] = useState(stored);
  const options = models?.models ?? [];
  // A stored model the list no longer names stays selectable, so the form never shows a wrong value.
  const listed = options.some((option) => option.value === stored) ? options : [{ value: stored, displayName: stored, description: "" }, ...options];
  const chosen = listed.find((option) => option.value === value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value !== stored) onSave(value === DEFAULT_MODEL ? null : value);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className={LABEL}>
        Модель Агентов
        <select name="model" value={value} disabled={models === undefined} onChange={(e) => setValue(e.target.value)} className={INPUT}>
          {listed.map((option) => (
            <option key={option.value} value={option.value}>
              {option.displayName}
            </option>
          ))}
        </select>
      </label>
      <div className="text-xs text-muted">
        {models === undefined
          ? "Список моделей подписки загружается…"
          : models.error
            ? `Список моделей не получен: ${models.error}`
            : (chosen?.description ?? "")}
      </div>
      <div className="text-xs text-muted">Для Реализатора, QA-Агента, Merger и Планировщика. Применяется с ближайшего запуска процесса Агента: идущий Ход доработает на прежней модели.</div>
      <div>
        <Button type="submit" variant="primary" disabled={busy || value === stored}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}

// The Settings page: numbers apply on the next cycle, secrets rewrite the env file and restart
// live Agents softly at the end of their Turn.
export function SettingsForm(props: SettingsFormProps) {
  const { settings } = props;
  const [maxParallelTasks, setMaxParallelTasks] = useState(String(settings.maxParallelTasks));
  const [maxQaRounds, setMaxQaRounds] = useState(String(settings.maxQaRounds));
  const [prearmEnabled, setPrearmEnabled] = useState(settings.prearmEnabled);
  const numbersChanged = Number(maxParallelTasks) !== settings.maxParallelTasks || Number(maxQaRounds) !== settings.maxQaRounds || prearmEnabled !== settings.prearmEnabled;

  const saveNumbers = (event: FormEvent) => {
    event.preventDefault();
    const patch: SettingsRequest = {};
    if (Number(maxParallelTasks) !== settings.maxParallelTasks) patch.maxParallelTasks = Number(maxParallelTasks);
    if (Number(maxQaRounds) !== settings.maxQaRounds) patch.maxQaRounds = Number(maxQaRounds);
    if (prearmEnabled !== settings.prearmEnabled) patch.prearmEnabled = prearmEnabled;
    if (Object.keys(patch).length > 0) props.onSave(patch);
  };

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-20" data-testid="settings">
      <Button variant="ghost" size="sm" className="-ml-2.5" onClick={props.onBack}>
        ← к панели
      </Button>
      <h1 className="mt-1 text-xl font-semibold">Настройки</h1>
      <p className="mt-1 text-sm text-muted">
        Продукт: <b className="text-fg">{settings.repo ?? "не задан"}</b>
      </p>
      {props.error && (
        <Banner tone="danger" role="alert" className="mt-4">
          {props.error}
        </Banner>
      )}
      {props.saved && !props.error && (
        <Banner tone="ok" role="status" className="mt-4">
          Сохранено.{" "}
          {"githubToken" in props.saved || "oauthToken" in props.saved || "password" in props.saved
            ? "Новые процессы получат новый env; живые Агенты перезапустятся по концу Хода."
            : "model" in props.saved
              ? "Модель применится с ближайшего запуска процесса Агента."
              : "Применится с ближайшего цикла Оркестратора."}
        </Banner>
      )}

      <Section title="Оркестратор">
        <form onSubmit={saveNumbers} className="flex flex-col gap-4">
          <div className="grid items-end gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            Параллельных Задач <span className="font-mono text-xs font-normal text-muted">(max_parallel_tasks)</span>
            <input type="number" name="maxParallelTasks" min={0} max={16} value={maxParallelTasks} onChange={(e) => setMaxParallelTasks(e.target.value)} className={INPUT} />
          </label>
          <label className={LABEL}>
            Лимит Кругов QA <span className="font-mono text-xs font-normal text-muted">(max_qa_rounds)</span>
            <input type="number" name="maxQaRounds" min={1} max={20} value={maxQaRounds} onChange={(e) => setMaxQaRounds(e.target.value)} className={INPUT} />
          </label>
          </div>
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" name="prearmEnabled" className="mt-0.5 h-4 w-4 accent-accent" checked={prearmEnabled} onChange={(e) => setPrearmEnabled(e.target.checked)} />
            Пре-арм: не стартовать новые Ходы при 5-часовом лимите от 95 %
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={props.busy || !numbersChanged}>
              Сохранить
            </Button>
          </div>
        </form>
      </Section>

      <Section title="Модель">
        <ModelForm current={settings.model} models={props.models} busy={props.busy} onSave={(model) => props.onSave({ model })} />
      </Section>

      <Section title="Секреты">
        <SecretForm
          name="githubToken"
          label="GitHub token"
          stored={settings.secrets.githubToken}
          type="password"
          busy={props.busy}
          hint={
            <>
              Перед сохранением токен проверяется на доступ к репозиторию Продукта.
              <GithubTokenHelp repo={settings.repo} />
            </>
          }
          onSave={(githubToken) => props.onSave({ githubToken })}
        />
        <SecretForm
          name="oauthToken"
          label="OAuth-токен Claude"
          stored={settings.secrets.oauthToken}
          type="password"
          busy={props.busy}
          hint={
            <>
              Результат <code>claude setup-token</code> на вашей машине. Перед сохранением выполняется smoke-query; Пауза из-за истёкшего токена снимется.
            </>
          }
          onSave={(oauthToken) => props.onSave({ oauthToken })}
        />
        <SecretForm
          name="password"
          label="Пароль Установки"
          stored={settings.secrets.password}
          type="password"
          busy={props.busy}
          hint="Открытые сессии остаются, новый вход только с новым паролем."
          onSave={(password) => props.onSave({ password })}
        />
      </Section>
    </main>
  );
}
