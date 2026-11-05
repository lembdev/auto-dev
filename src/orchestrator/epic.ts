import type { IssueNumber } from "../ids.js";
import { GitHubNotFoundError, type GitHubPort, type Issue } from "../ports/github.js";

// The parent issue of a Task and its closing criteria: the checklist the Implementer copies into the
// pull request and the Orchestrator ticks after merge.
export type Epic = {
  number: IssueNumber;
  title: string;
  criteria: string[];
};

const CHECKLIST_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;
const PART_OF = /^\s*Part of #(\d+)\s*$/im;

export type ChecklistItem = { text: string; checked: boolean };

// Every `- [ ]` / `- [x]` line of a Markdown body, in order.
export function parseChecklist(body: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = CHECKLIST_ITEM.exec(line);
    if (!match) continue;
    items.push({ text: match[2] ?? "", checked: match[1] !== " " });
  }
  return items;
}

// Native sub-issue parent first, the `Part of #N` convention of repositories without sub-issues second.
export function parentNumberOf(issue: Pick<Issue, "parentIssueNumber" | "body">): IssueNumber | undefined {
  if (issue.parentIssueNumber !== null) return issue.parentIssueNumber;
  const match = PART_OF.exec(issue.body);
  return match ? (Number(match[1]) as IssueNumber) : undefined;
}

export const epicOf = (parent: Issue): Epic => ({
  number: parent.number,
  title: parent.title,
  criteria: parseChecklist(parent.body).map((item) => item.text),
});

// The Epic of a Task, if it has a parent that still exists; a missing parent is not an error of the Task.
export async function findEpic(github: GitHubPort, issue: Issue): Promise<Epic | undefined> {
  const parentNumber = parentNumberOf(issue);
  if (parentNumber === undefined) return undefined;
  try {
    return epicOf(await github.getIssue(parentNumber));
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return undefined;
    throw error;
  }
}
