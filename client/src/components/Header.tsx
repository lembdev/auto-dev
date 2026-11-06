import type { LimitReading } from "../../../src/index/limit-samples.js";
import type { InstallationResponse } from "../../../src/server/api-types.js";
import type { ReactNode } from "react";
import { clockTime, limitLevel, type LimitLevel } from "../format.js";
import { Banner, Button, cx, LINK, Segmented } from "./ui.js";

export type Mode = "development" | "planning";

// Which screen is under the header: the mode's main screen or one of the pages linked at the right.
export type Page = "main" | "stats" | "settings";

export type HeaderProps = {
  installation: InstallationResponse | undefined;
  mode: Mode;
  onMode: (mode: Mode) => void;
  page: Page;
  onPage: (page: Page) => void;
  onPause: (paused: boolean) => void;
  pausePending: boolean;
  // Another smoke query on the current `claude` after a failed one.
  onRecheck?: () => void;
  recheckPending?: boolean;
  // "Обновить" in the banner of a newer release: starts the updater on the server.
  onUpdate?: () => void;
  updatePending?: boolean;
  updateError?: string | undefined;
  connected: boolean;
  now: number;
  onLogout: () => void;
};

const LEVEL_BAR: Record<LimitLevel, string> = { ok: "bg-ok", warn: "bg-warn-line", danger: "bg-danger" };
const LEVEL_TEXT: Record<LimitLevel, string> = { ok: "text-fg", warn: "text-warn", danger: "text-danger-text" };

function Limit({ name, reading, now }: { name: string; reading: LimitReading | null; now: number }) {
  if (!reading) {
    return (
      <div className="w-32 text-xs" data-testid={`limit-${name}`} data-level="none">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted">{name}</span>
          <span className="text-muted">нет данных</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle" />
      </div>
    );
  }
  const percent = Math.round(reading.usedPercent);
  const level = limitLevel(percent);
  return (
    <div className="w-32 text-xs" data-testid={`limit-${name}`} data-level={level} title={reading.resetsAt ? `Лимит ${name}: сброс ${clockTime(reading.resetsAt, now)}` : `Лимит ${name}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted">{name}</span>
        <span>
          <b className={`tabular-nums ${LEVEL_TEXT[level]}`}>{percent} %</b>
          {reading.resetsAt && <span className="text-muted"> · {clockTime(reading.resetsAt, now)}</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
        <i className={`block h-full rounded-full ${LEVEL_BAR[level]}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
    </div>
  );
}

const UPDATE_PHASE_TEXT: Record<string, string> = {
  requested: "обновление запущено, скачивается новый релиз",
  preparing: "пауза, ждём окончания текущих Ходов (до 10 минут)",
  ready: "Ходы остановлены, сервис перезапускается",
};

const PAUSE_SOURCE_TEXT: Record<string, string> = {
  human: "включена человеком",
  update: "идёт обновление",
  disk: "мало места на диске",
  token: "токен подписки истёк",
};

export function Header(props: HeaderProps) {
  const { installation, mode, page } = props;
  const paused = installation?.paused ?? false;
  const tokenPause = paused && installation?.pause?.source === "token" ? installation.pause : undefined;
  const claudeVersion = installation?.claudeVersion;
  const update = installation?.update;
  const navLink = (target: Page, label: string) => (
    <button
      type="button"
      aria-current={page === target ? "page" : undefined}
      className={cx("rounded-md px-2 py-1 text-sm transition-colors", page === target ? "bg-subtle font-medium text-fg" : "text-muted hover:bg-subtle hover:text-fg")}
      onClick={() => props.onPage(page === target ? "main" : target)}
    >
      {label}
    </button>
  );
  const banners: ReactNode[] = [];
  if (update && update.phase !== "idle") {
    banners.push(
      <Banner key="update" tone="accent" role="status" data-testid="update-banner">
        Обновление{update.latest ? ` до ${update.latest}` : ""}: {UPDATE_PHASE_TEXT[update.phase] ?? update.phase}. После перезапуска Агенты продолжат свои Ходы.
      </Banner>,
    );
  }
  if (update?.available && update.phase === "idle") {
    banners.push(
      <Banner
        key="available"
        tone="ok"
        role="status"
        data-testid="update-banner"
        action={
          <Button size="sm" variant="secondary" disabled={props.updatePending || !props.onUpdate} onClick={props.onUpdate}>
            Обновить
          </Button>
        }
      >
        <span>
          Доступна версия{" "}
          {update.latestUrl ? (
            <a className={`${LINK} font-medium`} href={update.latestUrl} target="_blank" rel="noreferrer">
              {update.latest}
            </a>
          ) : (
            <b>{update.latest}</b>
          )}{" "}
          (сейчас {update.current}). <span className="text-muted">Обновление ставит Установку на паузу, ждёт текущие Ходы до 10 минут и перезапускает сервис.</span>
        </span>
        {props.updateError && (
          <div className="mt-1 text-danger-text" role="alert">
            Не удалось запустить обновление: {props.updateError}
          </div>
        )}
      </Banner>,
    );
  }
  if (tokenPause) {
    banners.push(
      <Banner
        key="token"
        tone="danger"
        role="alert"
        data-testid="token-banner"
        action={
          <Button size="sm" variant="danger" onClick={() => props.onPage("settings")}>
            Обновить токен в Настройках
          </Button>
        }
      >
        Токен подписки истёк: Claude отклонил OAuth-токен. Новые Агенты не стартуют, пока не сохранён новый токен.
      </Banner>,
    );
  }
  if (paused && installation?.pause && !tokenPause) {
    banners.push(
      <Banner key="pause" tone="warn" role="status">
        Пауза ({PAUSE_SOURCE_TEXT[installation.pause.source] ?? installation.pause.source}: {installation.pause.reason}). Новые Задачи и новые Круги QA не стартуют, живые Ходы дорабатываются.
      </Banner>,
    );
  }
  if (claudeVersion?.status === "failed") {
    banners.push(
      <Banner
        key="claude"
        tone="danger"
        role="alert"
        data-testid="claude-version-banner"
        action={
          <Button size="sm" variant="danger" disabled={props.recheckPending} onClick={props.onRecheck}>
            Проверить снова
          </Button>
        }
      >
        Обновлённый claude {claudeVersion.current ?? "(версия неизвестна)"} не прошёл проверку: {claudeVersion.error}. Новые Агенты не стартуют, живые Сессии продолжают работу.
        {claudeVersion.rollbackCommand && (
          <div className="mt-1">
            Откат: <code className="rounded bg-subtle px-1 font-mono text-[0.9em]">{claudeVersion.rollbackCommand}</code>
          </div>
        )}
      </Banner>,
    );
  }
  if (!paused && installation?.blocker === "at_limit" && installation.atLimit) {
    banners.push(
      <Banner key="limit" tone="danger" role="status">
        У стены: лимит подписки исчерпан, новые Ходы стартуют после {clockTime(installation.atLimit.until, props.now)}.
      </Banner>,
    );
  }
  if (!paused && installation?.blocker === "prearm") {
    banners.push(
      <Banner key="prearm" tone="warn" role="status">
        Пре-арм: 5-часовой лимит почти исчерпан, новые Ходы ждут сброса.
      </Banner>,
    );
  }

  return (
    <header className="z-20 shrink-0 border-b border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <span className="min-w-0 truncate text-[15px] font-semibold" data-testid="product">
          {installation?.product ? (
            <a className="text-inherit no-underline hover:underline" href={installation.product.htmlUrl} target="_blank" rel="noreferrer">
              {installation.product.fullName}
            </a>
          ) : (
            <span className="text-muted">Продукт не настроен</span>
          )}
        </span>
        <Segmented<Mode>
          label="Режим"
          value={mode}
          onChange={(value) => {
            props.onMode(value);
            props.onPage("main");
          }}
          options={[
            { value: "development", label: "Разработка" },
            { value: "planning", label: "Планирование" },
          ]}
        />
        <div className="order-last flex w-full flex-wrap items-center gap-x-4 gap-y-2 md:order-none md:w-auto">
          <div className="flex gap-4">
            <Limit name="5 ч" reading={installation?.limits.fiveHour ?? null} now={props.now} />
            <Limit name="7 дн" reading={installation?.limits.sevenDay ?? null} now={props.now} />
          </div>
          <span className="rounded-md bg-subtle px-2 py-1 text-xs tabular-nums" title="Слоты: Агент работает или idle" data-testid="slots">
            <span className="text-muted">Слоты</span> {installation ? `${installation.slots.used} / ${installation.slots.max}` : "…"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={paused}
            disabled={!installation || props.pausePending}
            onClick={() => props.onPause(!paused)}
            title={paused ? "Снять Паузу" : "Новые Задачи и Круги QA не будут стартовать"}
            className={cx(
              "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm font-medium transition-colors disabled:opacity-50",
              paused ? "border-warn-line bg-warn-line text-black hover:brightness-105" : "border-line-strong hover:bg-surface-2",
            )}
          >
            <span aria-hidden className={cx("relative h-4 w-7 rounded-full transition-colors", paused ? "bg-black/25" : "bg-line-strong")}>
              <span className={cx("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all", paused ? "left-3.5" : "left-0.5")} />
            </span>
            {paused ? "Пауза: вкл" : "Пауза"}
          </button>
        </div>
        <span className="hidden flex-1 md:block" />
        <nav className="ml-auto flex items-center gap-1 md:ml-0" aria-label="Страницы">
          {navLink("stats", "Статистика")}
          {navLink("settings", "Настройки")}
          <span
            className="ml-1 inline-flex items-center gap-1.5 px-1 text-xs text-muted"
            title={props.connected ? "живые события подключены" : "нет связи с сервером, данные обновляются опросом"}
            data-testid="connection"
            data-connected={props.connected}
          >
            <span aria-hidden className={cx("h-2 w-2 rounded-full", props.connected ? "bg-ok" : "bg-line-strong")} />
            {props.connected ? "live" : "offline"}
            {installation?.version && <span className="hidden sm:inline">· {installation.version}</span>}
          </span>
          <Button variant="ghost" size="sm" onClick={props.onLogout}>
            Выйти
          </Button>
        </nav>
      </div>
      {banners.length > 0 && <div className="flex flex-col gap-2 px-4 pb-2.5">{banners}</div>}
    </header>
  );
}
