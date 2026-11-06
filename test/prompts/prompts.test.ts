import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IssueNumber, PullNumber } from "../../src/ids.js";
import { parseChecklist, parentNumberOf } from "../../src/orchestrator/epic.js";
import {
  DEFAULT_PROMPTS_DIR,
  NO_EPIC_TEXT,
  PROMPT_NAMES,
  PromptTemplateError,
  renderTemplate,
  StagePrompts,
  type StageContext,
} from "../../src/prompts/index.js";

const prompts = new StagePrompts();

const context: StageContext = {
  stage: "implement",
  issue: { number: 42 as IssueNumber, title: "Add login", body: "## What to build\n\nA login form.\n\n## Acceptance criteria\n\n- [ ] Users log in" },
  epic: { number: 7 as IssueNumber, title: "Accounts", criteria: ["Users can log in", "Users can log out"] },
  pullNumber: 5 as PullNumber,
  branch: "worktree-issue-42",
  worktree: "/var/lib/auto-dev/repo/.claude/worktrees/issue-42",
  round: 0,
};

describe("Stage prompts", () => {
  it("ship as Markdown files next to the code, at least the common part and the Implementer", () => {
    for (const name of ["common", "implement"] as const) {
      expect(existsSync(prompts.pathOf(name)), `${name}.md is missing in ${DEFAULT_PROMPTS_DIR}`).toBe(true);
    }
    expect(PROMPT_NAMES).toContain("qa");
  });

  it("common part carries every duty and prohibition of the spec", () => {
    const common = prompts.load("common");
    const required = [
      "CLAUDE.md",
      "GLOSSARY.md",
      "docs/agents",
      "docs/adr",
      "Работай только в этом worktree и только в этой ветке",
      "Один issue = один pull request",
      "Conventional Commits",
      "Не ставь и не снимай labels, assignee и milestone",
      "комментарии о статусе",
      "Не закрывай и не переоткрывай issue и pull request",
      "`ask_human`",
      "без других вызовов инструментов",
      "жди результата",
      "Не ослабляй и не выключай тесты",
    ];
    for (const phrase of required) expect(common, phrase).toContain(phrase);
    expect(common).not.toMatch(/[–—]/);
  });

  it("Implementer part demands the Epic criteria section in the pull request body", () => {
    const implement = prompts.load("implement");
    expect(implement).toContain("## Критерии Epic");
    expect(implement).toContain("Closes #{{issue_number}}");
    expect(implement).toContain("Замечания QA");
    expect(implement).not.toMatch(/[–—]/);
  });

  it("Merger part is only about the conflict: merge of the base branch, push, no other changes, ask_human as the way out", () => {
    const merge = prompts.load("merge");
    for (const phrase of ["git merge origin/{{base_branch}}", "Не делай rebase и force push", "Не меняй код сверх", "`ask_human`"]) {
      expect(merge, phrase).toContain(phrase);
    }
    expect(merge).not.toMatch(/[–—]/);
    const text = prompts.render({ ...context, stage: "merge", baseBranch: "develop" });
    expect(text).toContain("Стадии «Merge»");
    expect(text).toContain("git merge origin/develop");
    expect(text).not.toMatch(/\{\{/);
  });

  it("renders the common part and the Stage part with the issue, Epic, criteria, pull request and branch", () => {
    const text = prompts.render(context);
    expect(text).toContain("Стадии «Реализация» Задачи #42");
    expect(text).toContain("Issue #42: Add login");
    expect(text).toContain("A login form.");
    expect(text).toContain("Epic #7: Accounts");
    expect(text).toContain("- [ ] Users can log in\n- [ ] Users can log out");
    expect(text).toContain("Pull request: #5");
    expect(text).toContain("gh pr edit 5");
    expect(text).toContain("Ветка: `worktree-issue-42`");
    expect(text).toContain("Worktree Задачи: `/var/lib/auto-dev/repo/.claude/worktrees/issue-42`");
    expect(text).not.toMatch(/\{\{/);
    expect(text.indexOf("# Агент auto-dev")).toBeLessThan(text.indexOf("# Стадия «Реализация»"));
  });

  it("says so when the Task has no Epic", () => {
    const text = prompts.render({ ...context, epic: undefined });
    expect(text).toContain(NO_EPIC_TEXT);
  });

  it("Planner prompt stands alone and binds it to the tracker contract, reading first and no commits", () => {
    const text = prompts.renderPlan({ repoPath: "/var/lib/auto-dev/repo", baseBranch: "main" });
    expect(text).not.toContain("{{");
    expect(text).toContain("`/var/lib/auto-dev/repo`, ветка `main`");
    expect(text).toContain("docs/agents/issue-tracker.md");
    expect(text).toContain("Открытые milestones");
    expect(text).toContain("gh issue list --state open");
    expect(text).toContain("код, которого касается замысел");
    expect(text).toContain("не делай коммитов");
    expect(text).toContain("Существующие issues правь только по явной просьбе");
    expect(text).toContain("ready-for-agent");
    expect(text).toContain("Epic и Spec эту label не получают никогда");
    for (const skill of ["/wayfinder", "/to-spec", "/to-tickets"]) expect(text).toContain(skill);
    // The common Stage part is about worktrees and pull requests; the Planner has neither.
    expect(text).not.toContain(prompts.load("common").split("\n")[0]);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("rejects a template with a placeholder nobody fills", () => {
    expect(() => renderTemplate("qa", "Round {{round}} of {{rounds_max}}", { round: "1" })).toThrow(PromptTemplateError);
  });
});

describe("Epic criteria", () => {
  it("are the checklist lines of the parent body", () => {
    expect(parseChecklist("Intro\n- [ ] First\n* [x] Second done\n- plain\n  - [ ] Nested")).toEqual([
      { text: "First", checked: false },
      { text: "Second done", checked: true },
      { text: "Nested", checked: false },
    ]);
  });

  it("parent comes from sub-issues first, then from the Part of line", () => {
    expect(parentNumberOf({ parentIssueNumber: 3 as IssueNumber, body: "Part of #9" })).toBe(3);
    expect(parentNumberOf({ parentIssueNumber: null, body: "## Parent\n\nPart of #9\n" })).toBe(9);
    expect(parentNumberOf({ parentIssueNumber: null, body: "nothing" })).toBeUndefined();
  });
});
