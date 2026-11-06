import type { LimitReading } from "../../../src/index/limit-samples.js";
import type { InstallationResponse } from "../../../src/server/api-types.js";
import { clockTime, limitLevel, type LimitLevel } from "../format.js";

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
  connected: boolean;
  now: number;
  onLogout: () => void;
};

const LEVEL_BAR: Record<LimitLevel, string> = { ok: "bg-green-600", warn: "bg-amber-500", danger: "bg-red-600" };
const LEVEL_TEXT: Record<LimitLevel, string> = { ok: "", warn: "text-amber-600 dark:text-amber-400", danger: "text-red-600 dark:text-red-400" };

function Limit({ name, reading, now }: { name: string; reading: LimitReading | null; now: number }) {
  if (!reading) {
    return (
      <div className="min-w-36 text-xs" data-testid={`limit-${name}`} data-level="none">
        <div>
          {name}: <span className="text-neutral-500">нет данных</span>
        </div>
        <div className="my-0.5 h-1.5 overflow-hidden rounded bg-neutral-300 dark:bg-neutral-700" />
      </div>
    );
  }
  const percent = Math.round(reading.usedPercent);
  const level = limitLevel(percent);
  return (
    <div className="min-w-36 text-xs" data-testid={`limit-${name}`} data-level={level}>
      <div>
        {name}: <b className={LEVEL_TEXT[level]}>{percent} %</b>
        {reading.resetsAt && <span className="text-neutral-500"> · сброс {clockTime(reading.resetsAt, now)}</span>}
      </div>
      <div className="my-0.5 h-1.5 overflow-hidden rounded bg-neutral-300 dark:bg-neutral-700">
        <i className={`block h-full ${LEVEL_BAR[level]}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
    </div>
  );
}

const PAUSE_SOURCE_TEXT: Record<string, string> = {
  human: "включена человеком",
  update: "идёт обновление",
  disk: "мало места на диске",
  token: "токен подписки истёк",
};

export function Header(props: HeaderProps) {
  const { installation, mode, page } = props;
  const paused = installation?.paused ?? false;
  const segment = (value: Mode, label: string) => (
    <button
      type="button"
      onClick={() => {
        props.onMode(value);
        props.onPage("main");
      }}
      aria-pressed={mode === value}
      className={`px-3 py-1 ${mode === value ? "bg-blue-600 text-white" : "hover:bg-neutral-200 dark:hover:bg-neutral-700"}`}
    >
      {label}
    </button>
  );
  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-300 bg-white px-4 py-2 dark:border-neutral-700 dark:bg-neutral-900">
      <span className="text-[15px] font-semibold" data-testid="product">
        {installation?.product ? (
          <a className="text-inherit no-underline hover:underline" href={installation.product.htmlUrl} target="_blank" rel="noreferrer">
            {installation.product.fullName}
          </a>
        ) : (
          "Продукт не настроен"
        )}
      </span>
      <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 text-sm dark:border-neutral-700">
        {segment("development", "Режим разработки")}
        {segment("planning", "Режим планирования")}
      </div>
      <div className="flex gap-3">
        <Limit name="5 ч" reading={installation?.limits.fiveHour ?? null} now={props.now} />
        <Limit name="7 дн" reading={installation?.limits.sevenDay ?? null} now={props.now} />
      </div>
      <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400" title="Слоты: Агент работает или idle" data-testid="slots">
        Слоты {installation ? `${installation.slots.used} / ${installation.slots.max}` : "…"}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={paused}
        disabled={!installation || props.pausePending}
        onClick={() => props.onPause(!paused)}
        className={`rounded-md border px-3 py-1 text-sm ${paused ? "border-amber-500 bg-amber-500 text-neutral-900" : "border-neutral-300 hover:border-blue-600 dark:border-neutral-700"}`}
      >
        {paused ? "Пауза: вкл" : "Пауза"}
      </button>
      <span className="flex-1" />
      <nav className="flex gap-3 text-xs text-neutral-500">
        <button type="button" aria-current={page === "settings" ? "page" : undefined} className={page === "settings" ? "font-semibold text-neutral-900 dark:text-neutral-100" : "hover:underline"} onClick={() => props.onPage(page === "settings" ? "main" : "settings")}>
          Настройки
        </button>
        <button type="button" aria-current={page === "stats" ? "page" : undefined} className={page === "stats" ? "font-semibold text-neutral-900 dark:text-neutral-100" : "hover:underline"} onClick={() => props.onPage(page === "stats" ? "main" : "stats")}>
          Статистика
        </button>
        <span title={props.connected ? "живые события подключены" : "нет связи с сервером, данные обновляются опросом"} data-testid="connection" data-connected={props.connected}>
          {props.connected ? "● live" : "○ offline"}
        </span>
        <span>{installation?.version}</span>
        <button type="button" className="underline" onClick={props.onLogout}>
          выйти
        </button>
      </nav>
      {paused && installation?.pause && (
        <div className="flex w-full items-center gap-2 rounded-md border border-blue-600 bg-blue-50 px-3 py-1.5 text-sm dark:bg-blue-950" role="status">
          Пауза ({PAUSE_SOURCE_TEXT[installation.pause.source] ?? installation.pause.source}: {installation.pause.reason}). Новые Задачи и новые Круги QA не стартуют, живые Ходы дорабатываются.
        </div>
      )}
      {!paused && installation?.blocker === "at_limit" && installation.atLimit && (
        <div className="flex w-full items-center gap-2 rounded-md border border-red-600 bg-red-50 px-3 py-1.5 text-sm dark:bg-red-950" role="status">
          У стены: лимит подписки исчерпан, новые Ходы стартуют после {clockTime(installation.atLimit.until, props.now)}.
        </div>
      )}
      {!paused && installation?.blocker === "prearm" && (
        <div className="flex w-full items-center gap-2 rounded-md border border-amber-500 bg-amber-50 px-3 py-1.5 text-sm dark:bg-amber-950" role="status">
          Пре-арм: 5-часовой лимит почти исчерпан, новые Ходы ждут сброса.
        </div>
      )}
    </header>
  );
}
