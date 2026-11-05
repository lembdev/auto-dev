import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../agents/agent-runner.js";
import type { CommentId, HumanRequestId, IssueNumber } from "../ids.js";
import type { AgentRecord, AgentRole } from "../index/agents.js";
import { githubAnswerIdentity, type AnswerIdentity, type HumanRequest } from "../index/human-requests.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { AskHumanCall, AskHumanDecision } from "../ports/driver.js";
import { GitHubNotFoundError, type GitHubPort, type IssueComment } from "../ports/github.js";
import { isMarkedComment, type Comments } from "./comments.js";
import { defineIntent, type IntentJournal } from "./intents.js";

// Key of the Request comment: one per tool call, so a retry after a crash finds the comment already posted.
export const requestCommentKey = (toolUseId: string): string => `request:${toolUseId}`;

export const REACT_TO_ANSWER = defineIntent<{ commentId: CommentId }>("react-to-answer");

export const ANSWER_REACTION = "rocket";

const STAGE_NAMES: Record<AgentRole, string> = {
  implementer: "Реализация",
  qa: "QA",
  merger: "Merge",
  planner: "Планирование",
};

export type RequestText = { question: string; options: string[] | undefined };

// The body of the Request comment, without the markers.
export function requestCommentText(role: AgentRole, text: RequestText): string {
  const lines = [`**Запрос к человеку** (Стадия: ${STAGE_NAMES[role]})`, "", text.question.trim()];
  if (text.options && text.options.length > 0) {
    lines.push("", "Варианты:", ...text.options.map((option) => `- ${option}`));
  }
  lines.push("", "Ответьте комментарием здесь или в UI.");
  return lines.join("\n");
}

// The one line "who and from where" the Agent sees next to the Answer.
export const answerSourceLine = (comment: IssueComment): string => `${comment.author} in GitHub comment ${comment.htmlUrl}`;

export type HumanRequestsOptions = {
  github: GitHubPort;
  runner: AgentRunner;
  index: RuntimeIndex;
  log: Logger;
  clock: Clock;
  comments: Comments;
  journal: IntentJournal;
};

type Deferred = Extract<SDKMessage, { type: "result"; subtype: "success" }>;

// An Answer accepted from GitHub but not yet handed to the Session; the text lives only here until the
// PreToolUse hook of the resumed process takes it.
type PendingAnswer = { answer: string; source: string; identity: AnswerIdentity };

const isDeferred = (message: SDKMessage): message is Deferred =>
  message.type === "result" && message.subtype === "success" && message.terminal_reason === "tool_deferred";

// Questions of Agents to the human: the first ask_human call is deferred and published as a marked
// comment in the issue of the Task; the first unmarked comment after it is the Answer, which resumes the
// Session so the same tool call returns the Answer text. Every Answer is applied exactly once.
export class HumanRequests {
  private readonly _github: GitHubPort;
  private readonly _runner: AgentRunner;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _clock: Clock;
  private readonly _comments: Comments;
  private readonly _journal: IntentJournal;
  private readonly _pending = new Map<HumanRequestId, PendingAnswer>();
  private readonly _publishing = new Set<HumanRequestId>();
  // The last deferred call per issue, in case the result message comes without `deferred_tool_use`.
  private readonly _lastCalls = new Map<IssueNumber, AskHumanCall>();
  private _openChecked = false;

  constructor(options: HumanRequestsOptions) {
    this._github = options.github;
    this._runner = options.runner;
    this._index = options.index;
    this._log = options.log;
    this._clock = options.clock;
    this._comments = options.comments;
    this._journal = options.journal;
    this._journal.handle(REACT_TO_ANSWER, (payload) => this._react(payload.commentId));
    this._runner.onMessage((agent, message) => {
      if (isDeferred(message)) void this._publish(agent, message);
    });
  }

  // The PreToolUse decision for ask_human: defer the first call, allow it with the Answer once there is one.
  async askHuman(task: Task, call: AskHumanCall): Promise<AskHumanDecision> {
    const request = this._index.humanRequests.findByToolUse(call.toolUseId);
    if (!request) {
      this._lastCalls.set(task.issueNumber, call);
      return { kind: "defer" };
    }
    const pending = this._pending.get(request.id);
    if (!pending) {
      if (request.answeredAt !== null) {
        this._log.warn({ issue: task.issueNumber, request: request.id, toolUseId: call.toolUseId }, "answered request asked again; its Answer text is gone, deferring");
      }
      return { kind: "defer" };
    }
    const now = this._iso();
    this._index.transaction(() => {
      this._index.appliedAnswers.add({ requestId: request.id, source: pending.identity, appliedAt: now });
      this._index.humanRequests.update(request.id, { answeredAt: now });
    });
    this._pending.delete(request.id);
    this._log.info({ issue: task.issueNumber, request: request.id, source: pending.identity }, "answer delivered");
    return { kind: "allow", answer: pending.answer, source: pending.source };
  }

  // Polled comments, oldest first: the first unmarked one after an open Request becomes its Answer.
  async onIssueComments(comments: IssueComment[]): Promise<void> {
    const sorted = [...comments].sort((a, b) => a.id - b.id);
    for (const comment of sorted) {
      if (isMarkedComment(comment.body)) continue;
      const request = this._openRequestBefore(comment);
      if (!request) continue;
      try {
        await this._accept(request, comment);
      } catch (error) {
        this._log.error({ err: error, issue: comment.issueNumber, comment: comment.id }, "answer not accepted");
      }
    }
  }

  // Once per start, looks through the issues of open Requests for Answers the poll could have missed;
  // every cycle, resumes Sessions whose Answer is still waiting to be delivered and fills in Request comments.
  async deliver(): Promise<void> {
    if (!this._openChecked) {
      this._openChecked = true;
      await this._checkOpenRequests();
    }
    for (const request of this._index.humanRequests.listOpen()) {
      if (this._publishing.has(request.id)) continue;
      if (request.commentId === null) await this._fillCommentId(request);
      if (this._pending.has(request.id)) await this._resume(request);
    }
  }

  listOpen(): HumanRequest[] {
    return this._index.humanRequests.listOpen();
  }

  // Internals

  private async _publish(agent: AgentRecord, message: Deferred): Promise<void> {
    const deferred = message.deferred_tool_use;
    if (agent.issueNumber === null) {
      this._log.warn({ agent: agent.id, toolUseId: deferred?.id }, "ask_human outside a Task is not published");
      return;
    }
    const issueNumber = agent.issueNumber;
    const toolUseId = deferred?.id ?? this._lastCalls.get(issueNumber)?.toolUseId;
    if (toolUseId === undefined) {
      this._log.error({ agent: agent.id, issue: issueNumber }, "deferred turn without a tool call id; nothing to publish");
      return;
    }
    const text = this._requestText(issueNumber, deferred);
    this._lastCalls.delete(issueNumber);
    const existing = this._index.humanRequests.findByToolUse(toolUseId);
    if (existing && existing.commentId !== null) return;
    const request = existing ?? this._index.humanRequests.create({ agentId: agent.id, issueNumber, toolUseId, createdAt: this._iso() });
    if (!text) {
      this._log.error({ issue: issueNumber, request: request.id, toolUseId }, "deferred call without its question; the Request stays unpublished");
      return;
    }
    this._publishing.add(request.id);
    try {
      const comment = await this._comments.post(issueNumber, requestCommentKey(toolUseId), requestCommentText(agent.role, text));
      this._index.humanRequests.update(request.id, { commentId: comment.id });
      this._log.info({ issue: issueNumber, agent: agent.id, request: request.id, comment: comment.id }, "request published");
    } catch (error) {
      // The pending intent is finished by the journal on the next cycle; `deliver()` then records the comment id.
      this._log.error({ err: error, issue: issueNumber, request: request.id }, "request not published");
    } finally {
      this._publishing.delete(request.id);
    }
  }

  private _requestText(issueNumber: IssueNumber, deferred: Deferred["deferred_tool_use"]): RequestText | undefined {
    const input = deferred?.input as Partial<RequestText> | undefined;
    if (input && typeof input.question === "string") {
      return { question: input.question, options: Array.isArray(input.options) ? input.options.map(String) : undefined };
    }
    const call = this._lastCalls.get(issueNumber);
    return call ? { question: call.question, options: call.options } : undefined;
  }

  private async _fillCommentId(request: HumanRequest): Promise<void> {
    const comment = await this._comments.find(request.issueNumber, requestCommentKey(request.toolUseId));
    if (!comment) {
      this._log.warn({ issue: request.issueNumber, request: request.id }, "request has no comment in the issue yet");
      return;
    }
    this._index.humanRequests.update(request.id, { commentId: comment.id });
  }

  // The oldest open Request of the issue whose comment precedes this one.
  private _openRequestBefore(comment: IssueComment): HumanRequest | undefined {
    return this._index.humanRequests
      .listOpen()
      .find((request) => request.issueNumber === comment.issueNumber && request.commentId !== null && request.commentId < comment.id);
  }

  private async _accept(request: HumanRequest, comment: IssueComment): Promise<void> {
    const identity = githubAnswerIdentity(comment.id);
    if (this._index.appliedAnswers.find(identity)) {
      this._log.debug({ issue: comment.issueNumber, comment: comment.id }, "answer already applied");
      return;
    }
    const pending = this._pending.get(request.id);
    if (pending) {
      if (pending.identity.id !== identity.id) {
        this._log.debug({ issue: comment.issueNumber, comment: comment.id, request: request.id }, "a later comment while the Answer is on its way");
      }
      return;
    }
    this._pending.set(request.id, { answer: comment.body.trim(), source: answerSourceLine(comment), identity });
    this._log.info({ issue: comment.issueNumber, request: request.id, comment: comment.id, author: comment.author }, "answer accepted");
    try {
      await this._journal.run(REACT_TO_ANSWER, comment.issueNumber, { commentId: comment.id });
    } catch (error) {
      this._log.error({ err: error, comment: comment.id }, "reaction not added; retried with the pending intents");
    }
    await this._resume(request);
  }

  private async _resume(request: HumanRequest): Promise<void> {
    if (this._runner.isLive(request.agentId)) return;
    const issueNumber = request.issueNumber;
    try {
      this._runner.resume(request.agentId, { onAskHuman: (call) => this.askHuman(this._index.tasks.get(issueNumber), call) });
      this._log.info({ issue: issueNumber, agent: request.agentId, request: request.id }, "session resumed with the Answer");
    } catch (error) {
      this._log.error({ err: error, issue: issueNumber, agent: request.agentId }, "session not resumed; the Answer waits for the next cycle");
    }
  }

  private async _checkOpenRequests(): Promise<void> {
    const issues = new Set(this._index.humanRequests.listOpen().map((request) => request.issueNumber));
    for (const issueNumber of issues) {
      try {
        await this.onIssueComments(await this._github.listIssueComments(issueNumber));
      } catch (error) {
        this._log.error({ err: error, issue: issueNumber }, "open request not checked");
      }
    }
  }

  private async _react(commentId: CommentId): Promise<void> {
    try {
      await this._github.addCommentReaction(commentId, ANSWER_REACTION);
    } catch (error) {
      // The Answer was deleted before the reaction landed: nothing left to mark.
      if (!(error instanceof GitHubNotFoundError)) throw error;
    }
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}
