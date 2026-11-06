import type { AgentState } from "../../src/index/agents.js";
import type { TaskStage } from "../../src/index/tasks.js";
import type { TaskView } from "../../src/server/api-types.js";

export const AGENT_LABELS: Record<AgentState, string> = {
  running: "работает",
  idle: "idle",
  waiting: "ждёт человека",
  stopped: "агент завершён",
};

const STAGE_LABELS: Record<TaskStage, string> = {
  taken: "Взята",
  implement: "Реализация",
  qa: "QA",
  merge: "Merge",
  done: "Готово",
  stuck: "Тупик",
  cancelled: "Отменена",
};

// "QA · Круг 2 из 3": a Task in `qa` is in round `round + 1`.
export const stageLabel = (task: Pick<TaskView, "stage" | "round">, maxQaRounds: number): string =>
  task.stage === "qa" ? `QA · Круг ${task.round + 1} из ${maxQaRounds}` : STAGE_LABELS[task.stage];

export type LimitLevel = "ok" | "warn" | "danger";

export const limitLevel = (percent: number): LimitLevel => (percent >= 85 ? "danger" : percent >= 60 ? "warn" : "ok");

// "42 мин", "2 ч 10 мин", "3 дн 4 ч": a span of time; under a minute it is "< 1 мин".
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "< 1 мин";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  const days = Math.floor(hours / 24);
  return `${days} дн ${hours % 24} ч`;
}

// Time passed since `iso` at `now`; "только что" inside the first minute.
export function elapsed(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  return ms < 60_000 ? "только что" : duration(ms);
}

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

// A reset time: "14:30" today, else "чт 09:00".
export function clockTime(iso: string, now: number): string {
  const date = new Date(iso);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? time : `${WEEKDAYS[date.getDay()]} ${time}`;
}

export const firstLine = (text: string): string => text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";

export const dateTime = (iso: string): string => {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
