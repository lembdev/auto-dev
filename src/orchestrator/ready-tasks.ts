import type { Issue } from "../ports/github.js";

// Opt-in label of the Product's tracker contract; the Orchestrator removes it on take and never creates labels.
export const READY_LABEL = "ready-for-agent";
export const HUMAN_LABEL = "ready-for-human";
// Triage labels the Orchestrator never touches; an issue carrying one is not taken.
export const TRIAGE_LABELS: readonly string[] = ["needs-triage", "needs-info", "wontfix"];
// Organization issue types that are Tasks. Repositories without types carry `type: null`.
export const TASK_TYPES: readonly string[] = ["Task", "Bug"];

export type ReadyTaskContext = {
  // Login of the Installation: an issue it half-took (assignee set, label still on) stays Ready for a retry.
  login: string;
  // Issue numbers already in the Pipeline; they are never Ready even if a human put the label back.
  activeIssues: ReadonlySet<number>;
};

export const isReadyTask = (issue: Issue, context: ReadyTaskContext): boolean => {
  if (issue.state !== "open" || issue.isPullRequest) return false;
  if (!issue.labels.includes(READY_LABEL)) return false;
  if (issue.labels.some((label) => TRIAGE_LABELS.includes(label))) return false;
  if (issue.type !== null && !TASK_TYPES.includes(issue.type)) return false;
  if (issue.dependencies.blockedBy > 0) return false;
  if (issue.assignees.some((login) => login !== context.login)) return false;
  if (context.activeIssues.has(issue.number)) return false;
  return true;
};

// Milestones are numbered in creation order, so the number is the order of their creation.
const compareReady = (a: Issue, b: Issue): number => {
  if (a.milestone === null && b.milestone !== null) return 1;
  if (a.milestone !== null && b.milestone === null) return -1;
  if (a.milestone && b.milestone && a.milestone.number !== b.milestone.number) {
    return a.milestone.number - b.milestone.number;
  }
  return a.number - b.number;
};

// The Ready queue in take order: milestone by creation, issue number inside, no milestone last.
export const selectReadyTasks = (issues: Iterable<Issue>, context: ReadyTaskContext): Issue[] =>
  [...issues].filter((issue) => isReadyTask(issue, context)).sort(compareReady);
