import { useState, type FormEvent, type ReactNode } from "react";
import type { SettingsRequest, SettingsResponse } from "../../../src/server/api-types.js";

export type SettingsFormProps = {
  settings: SettingsResponse;
  busy: boolean;
  error: string | null;
  // The last patch that went through, to tell the human what was saved.
  saved: SettingsRequest | null;
  onSave: (patch: SettingsRequest) => void;
  onBack: () => void;
};

const INPUT = "mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const BUTTON = "rounded-md bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-neutral-500 uppercase">{title}</h2>
      {children}
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
    <form onSubmit={submit} className="mb-4 flex flex-col gap-2" data-testid={`secret-${name}`}>
      <label className="block text-sm">
        {label} <span className="text-neutral-500">{stored ? "(сохранён)" : "(не задан)"}</span>
        <input type={type} name={name} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className={INPUT} placeholder="новое значение" />
      </label>
      <div className="text-xs text-neutral-500">{hint}</div>
      <div>
        <button type="submit" disabled={busy || value.trim() === ""} className={BUTTON}>
          Сохранить
        </button>
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
    <main className="mx-auto max-w-2xl px-4 pt-3 pb-20" data-testid="settings">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Настройки</h1>
        <button type="button" onClick={props.onBack} className="text-sm text-blue-600 underline dark:text-blue-400">
          к панели
        </button>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Продукт: <b>{settings.repo ?? "не задан"}</b>
      </p>
      {props.error && (
        <div className="mt-3 rounded-md border border-red-600 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">
          {props.error}
        </div>
      )}
      {props.saved && !props.error && (
        <div className="mt-3 rounded-md border border-green-600 bg-green-50 px-3 py-2 text-sm dark:bg-green-950" role="status">
          Сохранено.{" "}
          {"githubToken" in props.saved || "oauthToken" in props.saved || "password" in props.saved
            ? "Новые процессы получат новый env; живые Агенты перезапустятся по концу Хода."
            : "Применится с ближайшего цикла Оркестратора."}
        </div>
      )}

      <Section title="Оркестратор">
        <form onSubmit={saveNumbers} className="flex flex-col gap-3">
          <label className="block text-sm">
            Параллельных Задач (max_parallel_tasks)
            <input type="number" name="maxParallelTasks" min={0} max={16} value={maxParallelTasks} onChange={(e) => setMaxParallelTasks(e.target.value)} className={INPUT} />
          </label>
          <label className="block text-sm">
            Лимит Кругов QA (max_qa_rounds)
            <input type="number" name="maxQaRounds" min={1} max={20} value={maxQaRounds} onChange={(e) => setMaxQaRounds(e.target.value)} className={INPUT} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="prearmEnabled" checked={prearmEnabled} onChange={(e) => setPrearmEnabled(e.target.checked)} />
            Пре-арм: не стартовать новые Ходы при 5-часовом лимите от 95 %
          </label>
          <div>
            <button type="submit" disabled={props.busy || !numbersChanged} className={BUTTON}>
              Сохранить
            </button>
          </div>
        </form>
      </Section>

      <Section title="Секреты">
        <SecretForm
          name="githubToken"
          label="GitHub token"
          stored={settings.secrets.githubToken}
          type="password"
          busy={props.busy}
          hint="Перед сохранением токен проверяется на доступ к репозиторию Продукта."
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
