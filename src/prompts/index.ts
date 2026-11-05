import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PullNumber } from "../ids.js";
import type { Epic } from "../orchestrator/epic.js";
import type { Issue } from "../ports/github.js";

// Stage prompts are Markdown files shipped with auto-dev; the Product cannot override them and
// influences the Agents only through its own CLAUDE.md, GLOSSARY.md, docs/agents and ADRs.
export const PROMPT_NAMES = ["common", "implement", "qa", "merge", "plan"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export type StageName = Exclude<PromptName, "common">;

// `prompts/` at the package root, next to `src/` in development and `dist/` after the build.
export const DEFAULT_PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

// Human-readable Stage names as the Agent sees them.
export const STAGE_TITLES: Record<StageName, string> = {
  implement: "Реализация",
  qa: "QA",
  merge: "Merge",
  plan: "Планирование",
};

// Everything a Stage prompt can mention. Later Stages fill the fields the Implementer leaves empty.
export type StageContext = {
  stage: StageName;
  issue: Pick<Issue, "number" | "title" | "body">;
  epic: Epic | undefined;
  pullNumber: PullNumber | null;
  branch: string;
  worktree: string;
  round: number;
  previousVerdict?: string;
  // Branch the pull request targets; the Merger merges it into the Task branch.
  baseBranch?: string;
};

export class PromptTemplateError extends Error {
  constructor(
    readonly prompt: string,
    readonly placeholder: string,
  ) {
    super(`prompt ${prompt} uses unknown placeholder {{${placeholder}}}`);
    this.name = "PromptTemplateError";
  }
}

export type PromptLoaderOptions = {
  dir?: string;
};

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

// Replaces every `{{name}}` with its value; an unknown name is a bug in the template, not in the data.
export function renderTemplate(name: string, template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new PromptTemplateError(name, key);
    return value;
  });
}

export const DEFAULT_BASE_BRANCH_NAME = "main";

export const NO_EPIC_TEXT = "Задача не входит в Epic: критериев Epic нет.";
export const NO_VERDICT_TEXT = "Прошлого вердикта нет: это первый Круг.";

export function renderEpic(epic: Epic | undefined): string {
  if (!epic) return NO_EPIC_TEXT;
  const lines = [`Epic #${epic.number}: ${epic.title}`];
  if (epic.criteria.length === 0) {
    lines.push("", "У Epic нет чек-листа критериев.");
  } else {
    lines.push("", "Критерии Epic (чек-лист, точные строки):", "", ...epic.criteria.map((criterion) => `- [ ] ${criterion}`));
  }
  return lines.join("\n");
}

export function templateVars(context: StageContext): Record<string, string> {
  return {
    stage: STAGE_TITLES[context.stage],
    issue_number: String(context.issue.number),
    issue_title: context.issue.title,
    issue_body: context.issue.body.trim() === "" ? "(тело issue пустое)" : context.issue.body.trim(),
    epic: renderEpic(context.epic),
    pull_number: context.pullNumber === null ? "ещё не создан" : String(context.pullNumber),
    branch: context.branch,
    worktree: context.worktree,
    round: String(context.round),
    previous_verdict: context.previousVerdict ?? NO_VERDICT_TEXT,
    base_branch: context.baseBranch ?? DEFAULT_BASE_BRANCH_NAME,
  };
}

// Reads and renders the prompt files; one instance per Orchestrator, files are read on every call
// so a test can point it at its own directory.
export class StagePrompts {
  private readonly _dir: string;

  constructor(options: PromptLoaderOptions = {}) {
    this._dir = options.dir ?? DEFAULT_PROMPTS_DIR;
  }

  get dir(): string {
    return this._dir;
  }

  pathOf(name: PromptName): string {
    return path.join(this._dir, `${name}.md`);
  }

  load(name: PromptName): string {
    return readFileSync(this.pathOf(name), "utf8");
  }

  // Common part followed by the Stage part, both rendered with the same variables.
  render(context: StageContext): string {
    const vars = templateVars(context);
    const common = renderTemplate("common", this.load("common"), vars);
    const stage = renderTemplate(context.stage, this.load(context.stage), vars);
    return `${common.trimEnd()}\n\n${stage.trimEnd()}\n`;
  }
}
