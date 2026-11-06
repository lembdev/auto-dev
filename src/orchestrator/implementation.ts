import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../agents/agent-runner.js";
import type { IssueNumber } from "../ids.js";
import type { AgentRecord } from "../index/agents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task, TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { AskHumanCall, AskHumanDecision } from "../ports/driver.js";
import type { GitHubPort, Issue } from "../ports/github.js";
import { StagePrompts } from "../prompts/index.js";
import { findEpic } from "./epic.js";
import { isTurnEnd } from "./turns.js";

export class ImplementerNotStartedError extends Error {
  constructor(readonly issueNumber: IssueNumber) {
    super(`task #${issueNumber} has no Implementer yet`);
    this.name = "ImplementerNotStartedError";
  }
}

export class WorkspaceNotReadyError extends Error {
  constructor(readonly issueNumber: IssueNumber) {
    super(`task #${issueNumber} has no worktree or pull request yet`);
    this.name = "WorkspaceNotReadyError";
  }
}

export type AskHumanHandler = (task: Task, call: AskHumanCall) => Promise<AskHumanDecision>;

export type ImplementationOptions = {
  github: GitHubPort;
  runner: AgentRunner;
  index: RuntimeIndex;
  log: Logger;
  prompts?: StagePrompts;
  transition: (issueNumber: IssueNumber, to: TaskStage, reason?: string) => Task;
  // Wired by the ask_human feature; without it the Driver tells the Agent the tool is unavailable.
  onAskHuman?: AskHumanHandler;
};


// The Implementation Stage: one Implementer Session per Task attempt, started in the worktree with
// the `implement` prompt. The end of each Turn hands the Task to QA.
export class Implementation {
  private readonly _github: GitHubPort;
  private readonly _runner: AgentRunner;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _prompts: StagePrompts;
  private readonly _transition: ImplementationOptions["transition"];
  private readonly _onAskHuman: AskHumanHandler | undefined;

  constructor(options: ImplementationOptions) {
    this._github = options.github;
    this._runner = options.runner;
    this._index = options.index;
    this._log = options.log;
    this._prompts = options.prompts ?? new StagePrompts();
    this._transition = options.transition;
    this._onAskHuman = options.onAskHuman;
    this._runner.onMessage((agent, message) => this._observe(agent, message));
  }

  // The Implementer of the current attempt: the newest implementer Agent created since the take.
  findImplementer(task: Task): AgentRecord | undefined {
    return this._index.agents
      .listByIssue(task.issueNumber)
      .filter((agent) => agent.role === "implementer" && agent.createdAt >= task.takenAt)
      .at(-1);
  }

  // Starts the Implementer of a taken Task and moves the Task into the Stage.
  async start(task: Task, issue: Issue): Promise<AgentRecord> {
    if (task.worktreePath === null || task.branch === null || task.pullNumber === null) {
      throw new WorkspaceNotReadyError(task.issueNumber);
    }
    const existing = this.findImplementer(task);
    if (existing) return existing;
    const epic = await findEpic(this._github, issue);
    const prompt = this._prompts.render({
      stage: "implement",
      issue,
      epic,
      pullNumber: task.pullNumber,
      branch: task.branch,
      worktree: task.worktreePath,
      round: task.round,
    });
    const agent = this._runner.start({
      issueNumber: task.issueNumber,
      role: "implementer",
      cwd: task.worktreePath,
      prompt,
      ...this._askHuman(task.issueNumber),
    });
    this._log.info({ issue: task.issueNumber, agent: agent.id, epic: epic?.number ?? null, cwd: task.worktreePath }, "implementer started");
    if (task.stage === "taken") this._transition(task.issueNumber, "implement", "implementer started");
    return agent;
  }

  // Next message into the living Session of the Implementer: QA blockers, a Dialogue line.
  // The Task returns to the Stage so the end of the Turn sends it to QA again.
  async send(issueNumber: IssueNumber, text: string): Promise<AgentRecord> {
    const task = this._index.tasks.get(issueNumber);
    const agent = this.findImplementer(task);
    if (!agent) throw new ImplementerNotStartedError(issueNumber);
    if (task.stage !== "implement") this._transition(issueNumber, "implement", "message to the implementer");
    await this._runner.send(agent.id, text, this._askHuman(issueNumber));
    return this._index.agents.get(agent.id);
  }

  // The ask_human handler bound to the Task, for a launch and for a resume after a restart.
  private _askHuman(issueNumber: IssueNumber): { onAskHuman?: (call: AskHumanCall) => Promise<AskHumanDecision> } {
    const handler = this._onAskHuman;
    return handler ? { onAskHuman: (call) => handler(this._index.tasks.get(issueNumber), call) } : {};
  }

  private _observe(agent: AgentRecord, message: SDKMessage): void {
    if (agent.role !== "implementer" || agent.issueNumber === null || !isTurnEnd(message)) return;
    const task = this._index.tasks.find(agent.issueNumber);
    if (!task || task.stage !== "implement" || this.findImplementer(task)?.id !== agent.id) return;
    if (message.type === "result" && message.is_error) {
      // A failed Turn is not finished work; the hang and restart handling decides what happens next.
      this._log.error({ issue: task.issueNumber, agent: agent.id, subtype: message.subtype }, "implementer turn failed");
      return;
    }
    this._transition(task.issueNumber, "qa", "implementer turn finished");
  }
}
