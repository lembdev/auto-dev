import { useState, type FormEvent, type ReactNode } from "react";
import type { RepositoryPermission, SetupAccessResponse, SetupSmokeResponse, SetupStatus, SetupStepId } from "../../../src/server/api-types.js";
import { GithubTokenHelp } from "./GithubTokenHelp.js";
import { Logo } from "./LoginScreen.js";
import { Banner, buttonClass, Card, cx, INPUT as INPUT_BASE, LINK as LINK_BASE, Spinner } from "./ui.js";

export type SetupWizardProps = {
  status: SetupStatus;
  busy: boolean;
  error: string | null;
  access: SetupAccessResponse | null;
  smoke: SetupSmokeResponse | null;
  onPassword: (password: string) => void;
  onRepository: (input: { repo: string; token: string }) => void;
  onCheckAccess: () => void;
  onOauth: (token: string) => void;
  onSmoke: () => void;
  onClone: () => void;
  onFinish: () => void;
};

export const STEP_TITLES: Record<SetupStepId, string> = {
  password: "Пароль Установки",
  repository: "Репозиторий и GitHub token",
  access: "Проверка доступа",
  oauth: "OAuth-токен Claude",
  smoke: "Проверка подписки",
  clone: "Клон Продукта",
};

const STEPS: SetupStepId[] = ["password", "repository", "access", "oauth", "smoke", "clone"];

export const PERMISSION_TITLES: Record<RepositoryPermission, string> = {
  metadataRead: "Metadata: read",
  contentsWrite: "Contents: write",
  issuesWrite: "Issues: write",
  pullRequestsWrite: "Pull requests: write",
  actionsRead: "Actions: read",
  statusesRead: "Commit statuses: read",
};

const INPUT = cx(INPUT_BASE, "mt-1.5 font-mono");
const BUTTON = cx(buttonClass("primary"), "self-start");
const LINK = cx(LINK_BASE, "text-sm");
const HINT = "text-sm text-muted";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      {children}
    </label>
  );
}

function PasswordStep({ busy, onSubmit }: { busy: boolean; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const mismatch = repeat !== "" && repeat !== password;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== "" && password === repeat) onSubmit(password);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className={HINT}>Этим паролем вы будете входить в веб-интерфейс Установки. Он хранится в виде argon2-хеша.</p>
      <Field label="Пароль">
        <input type="password" name="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} />
      </Field>
      <Field label="Ещё раз">
        <input type="password" name="repeat" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={INPUT} />
      </Field>
      {mismatch && <div className="text-sm text-danger-text">Пароли не совпадают.</div>}
      <button type="submit" disabled={busy || password === "" || mismatch} className={BUTTON}>
        Сохранить пароль
      </button>
    </form>
  );
}

function RepositoryStep({ busy, repo, onSubmit }: { busy: boolean; repo: string | null; onSubmit: (input: { repo: string; token: string }) => void }) {
  const [value, setValue] = useState(repo ?? "");
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() !== "" && token.trim() !== "") onSubmit({ repo: value.trim(), token: token.trim() });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className={HINT}>
        Fine-grained personal access token с доступом к одному репозиторию Продукта и правами <b>Issues: write</b>, <b>Pull requests: write</b>, <b>Contents: write</b>,{" "}
        <b>Actions: read</b>, <b>Commit statuses: read</b>, <b>Metadata: read</b>.
      </p>
      <GithubTokenHelp repo={value} />
      <Field label="Репозиторий (owner/name)">
        <input name="repo" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="acme/product" className={INPUT} />
      </Field>
      <Field label="GitHub token">
        <input type="password" name="token" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" className={INPUT} />
      </Field>
      <button type="submit" disabled={busy || value.trim() === "" || token.trim() === ""} className={BUTTON}>
        Сохранить
      </button>
    </form>
  );
}

function AccessStep({ busy, repo, access, onCheck, onBack }: { busy: boolean; repo: string | null; access: SetupAccessResponse | null; onCheck: () => void; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className={HINT}>
        Установка запросит репозиторий <b>{repo}</b> и проверит, что токен может писать в Issues, Pull requests и Contents.
      </p>
      {access && (
        <div role="status" data-testid="access-result" className={`rounded-lg border px-3 py-2.5 text-sm ${access.ok ? "border-ok/40 bg-ok-soft" : "border-danger/50 bg-danger-soft"}`}>
          {access.ok ? `Доступ к ${access.access?.fullName ?? repo} подтверждён.` : access.error}
          {access.access && (
            <ul className="mt-2 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {(Object.keys(PERMISSION_TITLES) as RepositoryPermission[]).map((permission) => (
                <li key={permission} data-testid={`permission-${permission}`} data-granted={access.access?.permissions[permission] ?? false}>
                  <span className={access.access?.permissions[permission] ? "text-ok" : "text-danger-text"}>{access.access?.permissions[permission] ? "✓" : "✗"}</span> {PERMISSION_TITLES[permission]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="button" onClick={onCheck} disabled={busy} className={BUTTON}>
          {busy && <Spinner />}
          {busy ? "Проверяем…" : "Проверить доступ"}
        </button>
        <button type="button" onClick={onBack} className={LINK}>
          Изменить репозиторий или токен
        </button>
      </div>
    </div>
  );
}

function OauthStep({ busy, onSubmit }: { busy: boolean; onSubmit: (token: string) => void }) {
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim() !== "") onSubmit(token.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className={HINT}>
        Агенты работают под вашей подпиской Claude. На своей машине, где уже выполнен вход в Claude Code, запустите
      </p>
      <pre className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm">claude setup-token</pre>
      <p className={HINT}>и вставьте напечатанный токен сюда. Он попадёт только в файл env Установки (права 0600).</p>
      <Field label="OAuth-токен">
        <input type="password" name="oauth" autoFocus autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" className={INPUT} />
      </Field>
      <button type="submit" disabled={busy || token.trim() === ""} className={BUTTON}>
        Сохранить
      </button>
    </form>
  );
}

function SmokeStep({ busy, smoke, onRun, onBack }: { busy: boolean; smoke: SetupSmokeResponse | null; onRun: () => void; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className={HINT}>Короткий запрос к Claude под сохранённым токеном: проверяет, что `claude` запускается на этой машине и подписка отвечает.</p>
      {smoke && (
        <div role="status" data-testid="smoke-result" className={`rounded-lg border px-3 py-2.5 text-sm ${smoke.ok ? "border-ok/40 bg-ok-soft" : "border-danger/50 bg-danger-soft"}`}>
          {smoke.ok ? `Claude ответил. Версия claude ${smoke.claudeVersion ?? "?"}, модель ${smoke.model ?? "?"}.` : smoke.error}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="button" onClick={onRun} disabled={busy} className={BUTTON}>
          {busy && <Spinner />}
          {busy ? "Ждём ответ…" : "Запустить проверку"}
        </button>
        <button type="button" onClick={onBack} className={LINK}>
          Изменить токен
        </button>
      </div>
    </div>
  );
}

function CloneStep({ busy, status, onClone }: { busy: boolean; status: SetupStatus; onClone: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className={HINT}>
        Установка клонирует <b>{status.repo}</b> в <code>{status.repoPath}</code>. Worktree Задач будут жить внутри клона.
      </p>
      <button type="button" onClick={onClone} disabled={busy} className={BUTTON}>
        {busy && <Spinner />}
        {busy ? "Клонируем…" : "Клонировать"}
      </button>
    </div>
  );
}

// The first-run wizard: the status names the current step, the human can step back to change a value.
export function SetupWizard(props: SetupWizardProps) {
  const { status } = props;
  const [editing, setEditing] = useState<SetupStepId | null>(null);
  const step: SetupStepId | "done" = editing ?? status.current;
  const done = (id: SetupStepId) => status.steps[id];
  const back = (to: SetupStepId) => setEditing(to);
  const submitting = <T,>(handler: (value: T) => void) => (value: T) => {
    setEditing(null);
    handler(value);
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-10" data-testid="setup-wizard" data-step={step}>
      <div className="flex items-baseline gap-2">
        <Logo />
        <span className="text-muted">первый запуск</span>
      </div>
      <ol className="mt-6 mb-4 grid grid-cols-6 gap-1.5" aria-label="Шаги">
        {STEPS.map((id, index) => (
          <li key={id} data-testid={`step-${id}`} data-done={done(id)} aria-current={step === id ? "step" : undefined} title={STEP_TITLES[id]} className="flex flex-col gap-1.5">
            <span className={cx("h-1 rounded-full", done(id) ? "bg-ok" : step === id ? "bg-accent" : "bg-subtle")} />
            <span className={cx("text-[11px] leading-tight max-sm:sr-only", step === id ? "font-semibold text-fg" : "text-muted")}>
              {index + 1}. {STEP_TITLES[id]}
              {done(id) ? " ✓" : ""}
            </span>
          </li>
        ))}
      </ol>
      <Card className="p-6">
      <h2 className="mb-3 text-base font-semibold">{step === "done" ? "Готово" : STEP_TITLES[step]}</h2>
      {props.error && (
        <Banner tone="danger" role="alert" className="mb-3">
          {props.error}
        </Banner>
      )}
      {step === "password" && <PasswordStep busy={props.busy} onSubmit={submitting(props.onPassword)} />}
      {step === "repository" && <RepositoryStep busy={props.busy} repo={status.repo} onSubmit={submitting(props.onRepository)} />}
      {step === "access" && <AccessStep busy={props.busy} repo={status.repo} access={props.access} onCheck={props.onCheckAccess} onBack={() => back("repository")} />}
      {step === "oauth" && <OauthStep busy={props.busy} onSubmit={submitting(props.onOauth)} />}
      {step === "smoke" && <SmokeStep busy={props.busy} smoke={props.smoke} onRun={props.onSmoke} onBack={() => back("oauth")} />}
      {step === "clone" && <CloneStep busy={props.busy} status={status} onClone={props.onClone} />}
      {step === "done" && (
        <div className="flex flex-col gap-3">
          <p className={HINT}>
            Продукт <b>{status.repo}</b> клонирован, Оркестратор начал опрос GitHub. Задачи с меткой <code>ready-for-agent</code> будут взяты в работу.
          </p>
          <button type="button" onClick={props.onFinish} className={BUTTON}>
            Открыть панель
          </button>
        </div>
      )}
      </Card>
    </main>
  );
}
