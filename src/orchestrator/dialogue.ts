import type { AgentRunner } from "../agents/agent-runner.js";
import type { AgentId, HumanRequestId, IssueNumber, PendingMessageId } from "../ids.js";
import type { AgentRecord } from "../index/agents.js";
import type { PendingMessage } from "../index/dialogue.js";
import { githubAnswerIdentity } from "../index/human-requests.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import { isActiveStage, type Task } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { AskHumanCall, AskHumanDecision } from "../ports/driver.js";
import type { IssueComment } from "../ports/github.js";
import { isMarkedComment } from "./comments.js";
import { currentAgentOf } from "./current-agent.js";
import type { HumanRequests, UiFrameIdentity } from "./human-requests.js";
import type { Implementation } from "./implementation.js";
import type { QaStage } from "./qa.js";

// Comments of GitHub share one sequence: the comment id, which only grows.
export const GITHUB_CLIENT_ID = "github";

export type DialogueFrame = UiFrameIdentity & { type: "dialogue"; issueNumber: IssueNumber; text: string };
export type AnswerFrame = UiFrameIdentity & { type: "answer"; requestId: HumanRequestId; text: string };

export type AckOutcome = "applied" | "duplicate" | "rejected";

// What the UI hears back for one frame. `watermark` is the highest `seq` of the client the
// Orchestrator has seen; a client whose counter is behind it raises it.
export type Ack = UiFrameIdentity & { watermark: number; outcome: AckOutcome; reason: string | null };

export type RemoveOutcome = "removed" | "not-found" | "delivered";

export type DialogueOptions = {
  index: RuntimeIndex;
  runner: AgentRunner;
  log: Logger;
  clock: Clock;
  humanRequests: HumanRequests;
  implementation: Implementation;
  qa: Pick<QaStage, "findReviewer">;
  canStartTurn: () => boolean;
};

export type DeliverOptions = {
  // Whether an Agent without a process is resumed for the line. A new line and the cycle do that; the
  // exit of a process (a crash, the idle timeout, a shutdown) does not.
  resumeStopped: boolean;
};

// The one line "from where" the Agent sees under a Dialogue line that came as a GitHub comment.
export const githubDialogueText = (comment: IssueComment): string => `${comment.body.trim()}\n\n(${comment.author} in GitHub comment ${comment.htmlUrl})`;

// Stages in which a line to the Implementer may start its Turn; in `merge` the Task is being merged.
const IMPLEMENTER_STAGES: ReadonlySet<Task["stage"]> = new Set(["implement", "qa"]);

// The Dialogue of the human with an Agent: lines from the UI and comments after an Answer go into the
// queue of the Task and reach the Session one per Turn, as the next user message once a Turn is over.
// Every frame of the UI is applied exactly once; its ACK says what became of it.
export class Dialogue {
  private readonly _index: RuntimeIndex;
  private readonly _runner: AgentRunner;
  private readonly _log: Logger;
  private readonly _clock: Clock;
  private readonly _humanRequests: HumanRequests;
  private readonly _implementation: Implementation;
  private readonly _qa: Pick<QaStage, "findReviewer">;
  private readonly _canStartTurn: () => boolean;
  // Agents with a delivery in flight, so two triggers never send the same line twice.
  private readonly _delivering = new Set<AgentId>();

  constructor(options: DialogueOptions) {
    this._index = options.index;
    this._runner = options.runner;
    this._log = options.log;
    this._clock = options.clock;
    this._humanRequests = options.humanRequests;
    this._implementation = options.implementation;
    this._qa = options.qa;
    this._canStartTurn = options.canStartTurn;
    // The end of a Turn is the moment for the next line; the other changes of the Task's Agents (a QA
    // round starting) are looked at too. The listeners of the message run after this one, so the
    // delivery waits a tick for the Stage to settle.
    this._runner.onStateChange((agent) => {
      if (agent.issueNumber === null) return;
      const issueNumber = agent.issueNumber;
      void Promise.resolve().then(() => this.deliverTo(issueNumber, { resumeStopped: false }));
    });
  }

  // One frame of the UI: queued, answered, seen before or refused for good.
  async receive(frame: DialogueFrame | AnswerFrame): Promise<Ack> {
    const watermark = this._index.dialogue.watermark(frame.clientId);
    if (frame.seq <= watermark) return this._ack(frame, "duplicate", null);
    if (frame.text.trim() === "") return this._reject(frame, "empty text");
    if (frame.type === "answer") return this._receiveAnswer(frame);
    const task = this._index.tasks.find(frame.issueNumber);
    if (!task || !isActiveStage(task.stage)) return this._reject(frame, "unknown or finished Task");
    this._enqueue(task, frame, frame.text.trim());
    this._log.info({ issue: task.issueNumber, client: frame.clientId, seq: frame.seq }, "dialogue line queued");
    return this._ack(frame, "applied", null);
  }

  // Lines of the Task not yet in its Session, oldest first.
  list(issueNumber: IssueNumber): PendingMessage[] {
    return this._index.dialogue.listUndelivered(issueNumber);
  }

  // The human takes a line back before it reached the Session.
  remove(issueNumber: IssueNumber, id: PendingMessageId): RemoveOutcome {
    const message = this._index.dialogue.find(id);
    if (!message || message.issueNumber !== issueNumber || message.requestId !== null) return "not-found";
    if (message.deliveredAt !== null) return "delivered";
    this._index.dialogue.remove(id);
    this._log.info({ issue: issueNumber, message: id }, "dialogue line removed");
    return "removed";
  }

  // Polled comments, oldest first: a human comment after an answered Request of an active Task is a
  // line of the Dialogue. The Answer itself and marked comments are not.
  async onIssueComments(comments: IssueComment[]): Promise<void> {
    const sorted = [...comments].sort((a, b) => a.id - b.id);
    for (const comment of sorted) {
      if (isMarkedComment(comment.body)) continue;
      const task = this._index.tasks.find(comment.issueNumber);
      if (!task || !isActiveStage(task.stage)) continue;
      if (this._humanRequests.claims(githubAnswerIdentity(comment.id))) continue;
      if (!this._followsAnswer(task, comment)) continue;
      if (comment.id <= this._index.dialogue.watermark(GITHUB_CLIENT_ID)) continue;
      this._enqueue(task, { clientId: GITHUB_CLIENT_ID, seq: comment.id }, githubDialogueText(comment));
      this._log.info({ issue: task.issueNumber, comment: comment.id, author: comment.author }, "dialogue line queued from a GitHub comment");
    }
  }

  // Every cycle: whatever can go into a Session now goes.
  async deliver(): Promise<void> {
    const issues = new Set(this._index.dialogue.listUndelivered().map((message) => message.issueNumber));
    for (const issueNumber of issues) await this.deliverTo(issueNumber, { resumeStopped: true });
  }

  // The oldest line of the Task goes to its Agent if the Agent is between Turns; the rest wait for the
  // next end of a Turn. A finished Task drops its queue.
  async deliverTo(issueNumber: IssueNumber, options: DeliverOptions = { resumeStopped: true }): Promise<void> {
    const task = this._index.tasks.find(issueNumber);
    const queue = this._index.dialogue.listUndelivered(issueNumber);
    if (queue.length === 0) return;
    if (!task || !isActiveStage(task.stage)) {
      for (const message of queue) this._index.dialogue.remove(message.id);
      this._log.warn({ issue: issueNumber, dropped: queue.length }, "dialogue lines dropped: the Task left the Pipeline");
      return;
    }
    const message = queue[0]!;
    const agent = this._targetOf(task, message);
    if (!agent || agent.state === "running" || agent.state === "waiting" || this._delivering.has(agent.id)) return;
    if (agent.state === "stopped" && !options.resumeStopped) return;
    if (!this._canStartTurn()) {
      this._log.debug({ issue: issueNumber, message: message.id }, "dialogue line waits: no new turns now");
      return;
    }
    let reviewer: AgentRecord | undefined;
    if (agent.role === "implementer") {
      if (!IMPLEMENTER_STAGES.has(task.stage)) return;
      if (task.stage === "qa") {
        // The line reopens the Implementation; the round of QA in progress is void. A round that has
        // not started yet is let start first, so it is not launched behind the line's back.
        reviewer = this._qa.findReviewer(task);
        if (!reviewer) return;
      }
    }
    this._delivering.add(agent.id);
    try {
      if (reviewer && this._runner.isLive(reviewer.id)) {
        await this._runner.stop(reviewer.id);
        this._log.info({ issue: issueNumber, agent: reviewer.id }, "qa round stopped for a line of the Dialogue to the Implementer");
      }
      await this._send(task, agent, message);
      this._index.dialogue.markDelivered(message.id, this._iso());
      this._log.info({ issue: issueNumber, agent: agent.id, message: message.id }, "dialogue line delivered");
    } catch (error) {
      this._log.error({ err: error, issue: issueNumber, agent: agent.id, message: message.id }, "dialogue line not delivered; retried on the next cycle");
    } finally {
      this._delivering.delete(agent.id);
    }
  }

  // Internals

  private async _receiveAnswer(frame: AnswerFrame): Promise<Ack> {
    const result = await this._humanRequests.answerFromUi(frame.requestId, frame.text, frame);
    switch (result.kind) {
      case "accepted":
        return this._ack(frame, "applied", null);
      case "rejected":
        return this._reject(frame, result.reason);
      case "already-answered": {
        const task = this._index.tasks.find(result.request.issueNumber);
        if (!task || !isActiveStage(task.stage)) return this._reject(frame, "already answered; the Task is finished");
        this._enqueue(task, frame, frame.text.trim());
        this._log.info({ issue: task.issueNumber, request: result.request.id, client: frame.clientId, seq: frame.seq }, "answer from the UI arrived second; it joins the Dialogue");
        return this._ack(frame, "rejected", "already answered; the text joins the Dialogue");
      }
    }
  }

  private _enqueue(task: Task, identity: UiFrameIdentity, text: string): PendingMessage {
    const agent = currentAgentOf(this._index.agents, task);
    const message = this._index.transaction(() => {
      const created = this._index.dialogue.enqueue({
        issueNumber: task.issueNumber,
        agentId: agent?.id ?? null,
        requestId: null,
        clientId: identity.clientId,
        seq: identity.seq,
        text,
        createdAt: this._iso(),
      });
      this._index.dialogue.advance(identity.clientId, identity.seq);
      return created;
    });
    void this.deliverTo(task.issueNumber);
    return message;
  }

  // Some Request of the Task was published before the comment and has its Answer.
  private _followsAnswer(task: Task, comment: IssueComment): boolean {
    return this._index.humanRequests
      .listByIssue(task.issueNumber)
      .some((request) => request.commentId !== null && request.commentId < comment.id && this._humanRequests.isAnswered(request));
  }

  // The Agent the line was written to, as long as its Session is still the one to talk to: the
  // Implementer of the attempt keeps its Session through QA; a QA or Merger Agent only during its round.
  private _targetOf(task: Task, message: PendingMessage): AgentRecord | undefined {
    const current = currentAgentOf(this._index.agents, task);
    if (message.agentId === null) return current;
    const written = this._index.agents.find(message.agentId);
    if (!written || written.createdAt < task.takenAt) return current;
    return written.role === "implementer" || written.id === current?.id ? written : current;
  }

  private async _send(task: Task, agent: AgentRecord, message: PendingMessage): Promise<void> {
    if (agent.role === "implementer") {
      await this._implementation.send(task.issueNumber, message.text);
      return;
    }
    const onAskHuman = (call: AskHumanCall): Promise<AskHumanDecision> => this._humanRequests.askHuman(this._index.tasks.get(task.issueNumber), call);
    await this._runner.send(agent.id, message.text, { onAskHuman });
  }

  private _reject(frame: UiFrameIdentity, reason: string): Ack {
    this._index.dialogue.advance(frame.clientId, frame.seq);
    this._log.warn({ client: frame.clientId, seq: frame.seq, reason }, "dialogue frame rejected");
    return this._ack(frame, "rejected", reason);
  }

  private _ack(frame: UiFrameIdentity, outcome: AckOutcome, reason: string | null): Ack {
    return { clientId: frame.clientId, seq: frame.seq, watermark: this._index.dialogue.watermark(frame.clientId), outcome, reason };
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}
