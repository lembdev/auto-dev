import type { AgentRunner } from "../agents/agent-runner.js";
import type { CommentId, IssueNumber } from "../ids.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task, TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { GitHubPort, IssueComment } from "../ports/github.js";
import { defineIntent, type IntentJournal } from "./intents.js";
import { HUMAN_LABEL } from "./ready-tasks.js";
import { stopAgentsOf } from "./stop-agents.js";

export type DeadEndPayload = { login: string; commentKey: string; text: string };
export type DeadEndResult = { commentId: CommentId };

// Marks the issue as a dead end in GitHub: label, assignee, comment with the reason. Idempotent.
export const DEAD_END = defineIntent<DeadEndPayload, DeadEndResult>("dead-end");

export type DeadEndsOptions = {
  github: GitHubPort;
  runner: AgentRunner;
  index: RuntimeIndex;
  log: Logger;
  journal: IntentJournal;
  transition: (issueNumber: IssueNumber, to: TaskStage, reason?: string) => Task;
  postComment: (issueNumber: IssueNumber, key: string, text: string) => Promise<IssueComment>;
};

// The dead end of a Task, shared by every Stage: the Task leaves the Pipeline for good, its Slot is freed,
// every Agent is stopped and the human gets the issue back with the reason. The worktree and the branch
// stay for the investigation.
export class DeadEnds {
  private readonly _github: GitHubPort;
  private readonly _runner: AgentRunner;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _journal: IntentJournal;
  private readonly _transition: DeadEndsOptions["transition"];
  private readonly _postComment: DeadEndsOptions["postComment"];
  private _login: string | undefined;

  constructor(options: DeadEndsOptions) {
    this._github = options.github;
    this._runner = options.runner;
    this._index = options.index;
    this._log = options.log;
    this._journal = options.journal;
    this._transition = options.transition;
    this._postComment = options.postComment;
    this._journal.handle(DEAD_END, (payload, intent) => this._mark(intent.issueNumber, payload));
  }

  // `reason` is the short transition reason shown in the UI, `text` the explanation for the human.
  async enter(issueNumber: IssueNumber, reason: string, text: string): Promise<Task> {
    const task = this._transition(issueNumber, "stuck", reason);
    await stopAgentsOf(this._runner, this._index.agents, issueNumber);
    this._log.warn({ issue: issueNumber, reason }, "task reached a dead end");
    const login = await this._loginOf();
    await this._journal.run(DEAD_END, issueNumber, {
      login,
      commentKey: `stuck:${task.attempt}`,
      text: `Тупик: ${text}\n\nЗадача передана человеку. Worktree и ветка оставлены для разбора; чтобы запустить Задачу заново, поставь метку \`ready-for-agent\`.`,
    });
    return task;
  }

  private async _mark(issueNumber: IssueNumber, payload: DeadEndPayload): Promise<DeadEndResult> {
    await this._github.addLabels(issueNumber, [HUMAN_LABEL]);
    await this._github.removeAssignees(issueNumber, [payload.login]);
    const comment = await this._postComment(issueNumber, payload.commentKey, payload.text);
    return { commentId: comment.id };
  }

  private async _loginOf(): Promise<string> {
    this._login ??= (await this._github.getAuthenticatedUser()).login;
    return this._login;
  }
}
