import type { AgentRunner } from "../agents/agent-runner.js";
import type { IssueNumber } from "../ids.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import { isActiveStage, type Task, type TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import { GitHubNotFoundError, type GitHubPort, type Issue } from "../ports/github.js";
import type { WorkspaceCleanup } from "./cleanup.js";
import { READY_LABEL } from "./ready-tasks.js";

export const CANCELLED_REASON = "issue closed without a merged pull request";

export type ReconcilerOptions = {
  github: GitHubPort;
  index: RuntimeIndex;
  log: Logger;
  runner: AgentRunner;
  cleanup: WorkspaceCleanup;
  transition: (issueNumber: IssueNumber, to: TaskStage, reason?: string) => Task;
  // Login of the Installation: the assignee a Task in progress must keep.
  login: () => string;
};

// Keeps GitHub and the index in step after a human touched the issue of a Task:
// - a closed issue without a merged pull request cancels the Task and removes its traces;
// - a reopened issue starts nothing (a new `ready-for-agent` makes it Ready again, as a new attempt);
// - a removed assignee or a returned `ready-for-agent` on a Task in progress is reverted silently.
// A Task in a dead end belongs to the human: only closing its issue has an effect.
export class Reconciler {
  private readonly _github: GitHubPort;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _runner: AgentRunner;
  private readonly _cleanup: WorkspaceCleanup;
  private readonly _transition: ReconcilerOptions["transition"];
  private readonly _login: () => string;

  constructor(options: ReconcilerOptions) {
    this._github = options.github;
    this._index = options.index;
    this._log = options.log;
    this._runner = options.runner;
    this._cleanup = options.cleanup;
    this._transition = options.transition;
    this._login = options.login;
  }

  // Issues updated since the last poll. The objects are the Orchestrator's own copies, so a
  // restoration is written back into them and the Ready queue sees the issue as it is now.
  async apply(issues: Issue[]): Promise<void> {
    for (const issue of issues) {
      const task = this._index.tasks.find(issue.number);
      if (!task) continue;
      try {
        await this._reconcile(issue, task);
      } catch (error) {
        this._log.error({ err: error, issue: issue.number, stage: task.stage }, "issue not reconciled");
      }
    }
  }

  private async _reconcile(issue: Issue, task: Task): Promise<void> {
    if (issue.state === "closed") {
      if (isActiveStage(task.stage) || task.stage === "stuck") await this._cancelUnlessMerged(issue, task);
      return;
    }
    if (isActiveStage(task.stage)) await this._restore(issue);
  }

  private async _cancelUnlessMerged(issue: Issue, task: Task): Promise<void> {
    if (await this._isMerged(task)) {
      this._log.debug({ issue: issue.number, pull: task.pullNumber }, "issue closed by its merged pull request");
      return;
    }
    this._transition(issue.number, "cancelled", CANCELLED_REASON);
    await this._stopAgents(issue.number);
    this._log.warn({ issue: issue.number, stage: task.stage, reason: issue.stateReason }, "task cancelled");
    await this._cleanup.run(task);
  }

  private async _isMerged(task: Task): Promise<boolean> {
    if (task.pullNumber === null) return false;
    try {
      return (await this._github.getPullRequest(task.pullNumber)).merged;
    } catch (error) {
      if (error instanceof GitHubNotFoundError) return false;
      throw error;
    }
  }

  private async _stopAgents(issueNumber: IssueNumber): Promise<void> {
    await Promise.all(
      this._index.agents
        .listByIssue(issueNumber)
        .filter((agent) => this._runner.isLive(agent.id))
        .map((agent) => this._runner.stop(agent.id)),
    );
  }

  private async _restore(issue: Issue): Promise<void> {
    const login = this._login();
    if (!issue.assignees.includes(login)) {
      await this._github.addAssignees(issue.number, [login]);
      issue.assignees.push(login);
      this._log.info({ issue: issue.number }, "assignee restored");
    }
    if (issue.labels.includes(READY_LABEL)) {
      try {
        await this._github.removeLabel(issue.number, READY_LABEL);
      } catch (error) {
        if (!(error instanceof GitHubNotFoundError)) throw error;
      }
      issue.labels = issue.labels.filter((label) => label !== READY_LABEL);
      this._log.info({ issue: issue.number }, "ready label removed from a task in progress");
    }
  }
}
