import type { AgentRunner } from "../agents/agent-runner.js";
import type { AgentId, IssueNumber } from "../ids.js";
import type { AgentRecord } from "../index/agents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { AskHumanDecision } from "../ports/driver.js";
import { currentAgentOf } from "./current-agent.js";
import type { StartBlocker } from "./installation-state.js";
import { DEAD_END_ASK_HUMAN_ANSWER, deadEndQuestionPrompt } from "./dead-end-question-prompt.js";

export { DEAD_END_ASK_HUMAN_ANSWER, DEAD_END_QUESTION_NOTE, deadEndQuestionPrompt } from "./dead-end-question-prompt.js";


export type DeadEndQuestionRefusal = "not-found" | "not-stuck" | "no-agent" | "no-session" | "busy" | "on-hold";

export type DeadEndQuestionResult =
  | { kind: "asked"; agent: AgentRecord }
  | { kind: "refused"; reason: Exclude<DeadEndQuestionRefusal, "on-hold"> }
  | { kind: "refused"; reason: "on-hold"; blocker: StartBlocker };

export type DeadEndQuestionsOptions = {
  index: RuntimeIndex;
  runner: AgentRunner;
  log: Logger;
  // Why no new Turn may start now (Pause, the limit, pre-arm, a blocked CLI); undefined when one may.
  blocker: () => StartBlocker | undefined;
};

// A question of the human to the Agent of the last step of a Task in a dead end: its Session is resumed
// in the worktree for one Turn and the process is stopped again once the Turn is over. This is a
// conversation only: the Task stays in the dead end, the Stages ignore the Turn since the Task is not in
// their Stage any more.
export class DeadEndQuestions {
  private readonly _index: RuntimeIndex;
  private readonly _runner: AgentRunner;
  private readonly _log: Logger;
  private readonly _blocker: () => StartBlocker | undefined;
  // Agents answering a question right now; their process goes once the Turn ends.
  private readonly _answering = new Set<AgentId>();

  constructor(options: DeadEndQuestionsOptions) {
    this._index = options.index;
    this._runner = options.runner;
    this._log = options.log;
    this._blocker = options.blocker;
    this._runner.onStateChange((agent) => this._observeState(agent));
  }

  ask(issueNumber: IssueNumber, text: string): DeadEndQuestionResult {
    const task = this._index.tasks.find(issueNumber);
    if (!task) return { kind: "refused", reason: "not-found" };
    if (task.stage !== "stuck") return { kind: "refused", reason: "not-stuck" };
    const agent = currentAgentOf(this._index.agents, task);
    if (!agent) return { kind: "refused", reason: "no-agent" };
    if (agent.sessionId === null) return { kind: "refused", reason: "no-session" };
    if (this._runner.isLive(agent.id)) return { kind: "refused", reason: "busy" };
    const blocker = this._blocker();
    if (blocker !== undefined) return { kind: "refused", reason: "on-hold", blocker };
    this._answering.add(agent.id);
    try {
      const resumed = this._runner.resume(agent.id, {
        prompt: deadEndQuestionPrompt(text),
        onAskHuman: async (): Promise<AskHumanDecision> => ({ kind: "allow", answer: DEAD_END_ASK_HUMAN_ANSWER }),
      });
      this._log.info({ issue: issueNumber, agent: agent.id, role: agent.role }, "dead-end question sent to the agent");
      return { kind: "asked", agent: resumed };
    } catch (error) {
      this._answering.delete(agent.id);
      throw error;
    }
  }

  private _observeState(agent: AgentRecord): void {
    if (!this._answering.has(agent.id) || agent.state === "running") return;
    this._answering.delete(agent.id);
    if (agent.state === "stopped") return;
    this._log.info({ issue: agent.issueNumber, agent: agent.id }, "dead-end question answered, stopping the agent");
    this._runner.stop(agent.id).catch((error: unknown) => this._log.error({ err: error, agent: agent.id }, "agent not stopped after a dead-end question"));
  }
}
