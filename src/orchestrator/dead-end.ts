import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../agents/agent-runner.js";
import type { CommentId, IssueNumber } from "../ids.js";
import type { AgentRecord, AgentRole } from "../index/agents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task, TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { GitHubPort, IssueComment } from "../ports/github.js";
import { currentAgentOf } from "./current-agent.js";
import { defineIntent, type IntentJournal } from "./intents.js";
import { findLastAssistantText, quoteMarkdown, truncateMessage } from "./last-message.js";
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
  // The Session history of an Agent from disk, for the last message when the feed no longer holds it.
  sessionHistory?: (agent: AgentRecord) => Promise<SDKMessage[]>;
};

// The Agent role as the dead-end comment names it.
const ROLE_LABELS: Record<AgentRole, string> = {
  implementer: "Реализатора",
  qa: "QA",
  merger: "Merger",
  planner: "Планировщика",
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
  private readonly _sessionHistory: DeadEndsOptions["sessionHistory"];
  private _login: string | undefined;

  constructor(options: DeadEndsOptions) {
    this._github = options.github;
    this._runner = options.runner;
    this._index = options.index;
    this._log = options.log;
    this._journal = options.journal;
    this._transition = options.transition;
    this._postComment = options.postComment;
    this._sessionHistory = options.sessionHistory;
    this._journal.handle(DEAD_END, (payload, intent) => this._mark(intent.issueNumber, payload));
  }

  // `reason` is the short transition reason shown in the UI, `text` the explanation for the human.
  // The last text of the Agent the Task was about goes with the reason into the index and the comment.
  async enter(issueNumber: IssueNumber, reason: string, text: string): Promise<Task> {
    // Taken before the transition: in Implementation the Task is about the Implementer, not the newest Agent.
    const agent = currentAgentOf(this._index.agents, this._index.tasks.get(issueNumber));
    const task = this._transition(issueNumber, "stuck", reason);
    await stopAgentsOf(this._runner, this._index.agents, issueNumber);
    this._log.warn({ issue: issueNumber, reason }, "task reached a dead end");
    const lastMessage = agent ? await this._lastMessageOf(agent) : undefined;
    this._index.deadEnds.record({
      issueNumber,
      attempt: task.attempt,
      agentId: agent?.id ?? null,
      agentRole: agent?.role ?? null,
      lastMessage: lastMessage ?? null,
      at: task.updatedAt,
    });
    const quote = agent && lastMessage ? `\n\nПоследнее сообщение ${ROLE_LABELS[agent.role]}:\n\n${quoteMarkdown(lastMessage)}` : "";
    const login = await this._loginOf();
    await this._journal.run(DEAD_END, issueNumber, {
      login,
      commentKey: `stuck:${task.attempt}`,
      text: `Тупик: ${text}${quote}\n\nЗадача передана человеку. Worktree и ветка оставлены для разбора; чтобы запустить Задачу заново, поставь метку \`ready-for-agent\`.`,
    });
    return task;
  }

  // The in-memory feed first; after a restart it is empty and the Session history is read from disk.
  private async _lastMessageOf(agent: AgentRecord): Promise<string | undefined> {
    let text = findLastAssistantText(this._runner.feed.after(agent.id, 0).map((entry) => entry.message));
    if (text === undefined && agent.sessionId !== null && this._sessionHistory) {
      try {
        text = findLastAssistantText(await this._sessionHistory(agent));
      } catch (error) {
        this._log.warn({ err: error, agent: agent.id }, "last message of the agent unavailable");
      }
    }
    return text === undefined ? undefined : truncateMessage(text);
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
