import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../agents/agent-runner.js";
import type { IssueNumber } from "../ids.js";
import type { AgentRecord } from "../index/agents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task, TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { AskHumanCall } from "../ports/driver.js";
import type { GitHubPort, Issue } from "../ports/github.js";
import { StagePrompts } from "../prompts/index.js";
import { isTurnEnd } from "./turns.js";
import type { DeadEnds } from "./dead-end.js";
import type { AskHumanHandler, Implementation } from "./implementation.js";
import type { MergeFailure } from "./merge.js";
import type { QaStage } from "./qa.js";

// Transition reasons of the Merger; the UI and the QA Stage read them from `transitions`.
export const MERGER_STARTED_REASON = "merger started: conflict with the base branch";
export const EXTRA_ROUND_REASON = "merger finished: extra qa round";

export type MergerOptions = {
  github: GitHubPort;
  runner: AgentRunner;
  index: RuntimeIndex;
  log: Logger;
  clock: Clock;
  deadEnds: DeadEnds;
  implementation: Implementation;
  qa: QaStage;
  prompts?: StagePrompts;
  transition: (issueNumber: IssueNumber, to: TaskStage, reason?: string) => Task;
  findIssue: (issueNumber: IssueNumber) => Promise<Issue>;
  baseBranch: string;
  // False while the Installation is paused or at the limit: no Merger starts, the conflict waits.
  canStart?: () => boolean;
  // True for a Merger whose Turn a restart cut short and that the recovery is about to resume.
  isPendingResume?: (id: AgentRecord["id"]) => boolean;
  onAskHuman?: AskHumanHandler;
};

// The Merger of one attempt, in memory only: after a restart the Merger is resumed by the recovery and
// its Turn end is taken without the head check (the head before the conflict is not known any more).
// `nudged` is set once the Merger got the reminder after a Turn without a push; `nudgePending` while
// that reminder waits for new Turns to be allowed again.
type Resolution = {
  attempt: number;
  agentId: AgentRecord["id"];
  sha: string;
  settling: boolean;
  nudged: boolean;
  nudgePending: boolean;
};

// What the Merge Stage does when the pull request cannot be merged. A conflict with the base branch
// brings a Merger up in the worktree of the Task (a new Session with the `merge` prompt); once its Turn
// is over the Task gets one extra QA round that does not count against the limit. Red checks are a
// remark to the Implementer and count as a round. Hung checks and a refused merge stay dead ends.
export class Merger {
  private readonly _github: GitHubPort;
  private readonly _runner: AgentRunner;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _clock: Clock;
  private readonly _deadEnds: DeadEnds;
  private readonly _implementation: Implementation;
  private readonly _qa: QaStage;
  private readonly _prompts: StagePrompts;
  private readonly _transition: MergerOptions["transition"];
  private readonly _findIssue: MergerOptions["findIssue"];
  private readonly _baseBranch: string;
  private readonly _canStart: () => boolean;
  private readonly _onAskHuman: AskHumanHandler | undefined;
  private readonly _isPendingResume: (id: AgentRecord["id"]) => boolean;
  private readonly _resolutions = new Map<IssueNumber, Resolution>();

  constructor(options: MergerOptions) {
    this._github = options.github;
    this._runner = options.runner;
    this._index = options.index;
    this._log = options.log;
    this._clock = options.clock;
    this._deadEnds = options.deadEnds;
    this._implementation = options.implementation;
    this._qa = options.qa;
    this._prompts = options.prompts ?? new StagePrompts();
    this._transition = options.transition;
    this._findIssue = options.findIssue;
    this._baseBranch = options.baseBranch;
    this._canStart = options.canStart ?? (() => true);
    this._onAskHuman = options.onAskHuman;
    this._isPendingResume = options.isPendingResume ?? (() => false);
    this._runner.onMessage((agent, message) => this._observe(agent, message));
  }

  // The Merger of the current attempt: the newest merger Agent created since the take.
  findMerger(task: Task): AgentRecord | undefined {
    return this._index.agents
      .listByIssue(task.issueNumber)
      .filter((agent) => agent.role === "merger" && agent.createdAt >= task.takenAt)
      .at(-1);
  }

  // Whether a Merger is still working on the conflict: its process lives, it waits for an Answer or for
  // its reminder, or a restart cut its Turn short and the recovery resumes it.
  isResolving(task: Task): boolean {
    const merger = this.findMerger(task);
    if (merger === undefined) return false;
    const resolution = this._resolutions.get(task.issueNumber);
    const nudgePending = resolution?.agentId === merger.id && resolution.nudgePending;
    return this._runner.isLive(merger.id) || merger.state === "waiting" || this._isPendingResume(merger.id) || nudgePending;
  }

  // Reminders held back while new Turns were not allowed go out on the first cycle that allows them.
  async deliverNudges(): Promise<void> {
    for (const [issueNumber, resolution] of this._resolutions) {
      if (!resolution.nudgePending) continue;
      if (!this._canStart()) return;
      const task = this._index.tasks.find(issueNumber);
      if (!task || task.stage !== "merge" || this.findMerger(task)?.id !== resolution.agentId) {
        this._resolutions.delete(issueNumber);
        continue;
      }
      await this._nudge(task, resolution);
    }
  }

  // Handler for `MergeStageOptions.onFailure`: true once the failure is taken care of here.
  async onFailure(task: Task, failure: MergeFailure): Promise<boolean> {
    switch (failure.kind) {
      case "conflict":
        return this._resolveConflict(task, failure);
      case "red-checks":
        return this._returnRedChecks(task, failure);
      default:
        return false;
    }
  }

  private async _resolveConflict(task: Task, failure: MergeFailure): Promise<boolean> {
    if (this.isResolving(task)) return true;
    if (task.worktreePath === null || task.branch === null) return false;
    if (!this._canStart()) {
      // The conflict is still there on the next cycle; the Merge Stage reports it again.
      this._log.debug({ issue: task.issueNumber }, "merger not started: new Turns are on hold");
      return true;
    }
    const issue = await this._findIssue(task.issueNumber);
    const prompt = this._prompts.render({
      stage: "merge",
      issue,
      epic: undefined,
      pullNumber: task.pullNumber,
      branch: task.branch,
      worktree: task.worktreePath,
      round: task.round,
      baseBranch: this._baseBranch,
    });
    const agent = this._runner.start({
      issueNumber: task.issueNumber,
      role: "merger",
      cwd: task.worktreePath,
      prompt,
      ...this._askHuman(task.issueNumber),
    });
    this._resolutions.set(task.issueNumber, {
      attempt: task.attempt,
      agentId: agent.id,
      sha: failure.sha,
      settling: false,
      nudged: false,
      nudgePending: false,
    });
    this._transition(task.issueNumber, "merge", MERGER_STARTED_REASON);
    this._log.info({ issue: task.issueNumber, agent: agent.id, sha: failure.sha }, "merger started");
    return true;
  }

  // Red checks go to the Implementer as a remark and count as a QA round; past the limit it is a dead end.
  private async _returnRedChecks(task: Task, failure: MergeFailure & { kind: "red-checks" }): Promise<boolean> {
    if (!this._implementation.findImplementer(task)) return false;
    const checked = task.round + 1;
    const max = this._qa.maxRounds();
    const failed = failure.failed.join(", ");
    if (checked >= max) {
      await this._deadEnds.enter(
        task.issueNumber,
        `qa rounds exhausted: ${checked} of ${max}`,
        `Красные проверки CI (${failed}) на PR #${task.pullNumber}, а лимит Кругов QA исчерпан (${checked} из ${max}).`,
      );
      return true;
    }
    this._index.tasks.update(task.issueNumber, { round: checked }, this._iso());
    this._transition(task.issueNumber, "implement", `red checks: ${failed}`);
    await this._implementation.send(task.issueNumber, redChecksMessage(task, failure));
    this._log.info({ issue: task.issueNumber, round: checked, failed: failure.failed }, "red checks sent to the implementer");
    return true;
  }

  private _observe(agent: AgentRecord, message: SDKMessage): void {
    if (agent.role !== "merger" || agent.issueNumber === null || !isTurnEnd(message) || message.type !== "result") return;
    const task = this._index.tasks.find(agent.issueNumber);
    if (!task || task.stage !== "merge" || this.findMerger(task)?.id !== agent.id) return;
    const resolution = this._resolutions.get(task.issueNumber);
    if (resolution?.settling) return;
    if (resolution) resolution.settling = true;
    const work = message.is_error
      ? this._deadEnd(task, "merger turn failed", `Ход Merger завершился ошибкой (${message.subtype}).`)
      : this._finish(task, resolution);
    work.catch((error: unknown) => this._log.error({ err: error, issue: task.issueNumber }, "merger result not applied"));
  }

  // The Merger is done: its process goes, the Task gets its extra QA round on the new head. A Turn that
  // pushed nothing gets one reminder into the same Session; the second such Turn in a row is a dead end.
  private async _finish(task: Task, resolution: Resolution | undefined): Promise<void> {
    if (task.pullNumber !== null && resolution) {
      const pull = await this._github.getPullRequest(task.pullNumber);
      if (pull.head.sha === resolution.sha) {
        if (!resolution.nudged) {
          resolution.nudged = true;
          await this._nudge(task, resolution);
          return;
        }
        await this._deadEnd(
          task,
          "merge: conflict left unresolved",
          `Merger завершил Ход, не запушив ничего в PR #${task.pullNumber}, и после напоминания снова ничего не запушил: конфликт с \`${this._baseBranch}\` остался.`,
        );
        return;
      }
    }
    const merger = this.findMerger(task);
    if (merger) await this._runner.stop(merger.id);
    this._resolutions.delete(task.issueNumber);
    this._transition(task.issueNumber, "qa", EXTRA_ROUND_REASON);
    this._log.info({ issue: task.issueNumber }, "merger finished, extra qa round");
    await this._qa.ensureRound(task.issueNumber);
  }

  // The reminder after a Turn without a push goes into the same Session; the end of the next Turn is
  // checked again. While new Turns are on hold it waits for `deliverNudges`.
  private async _nudge(task: Task, resolution: Resolution): Promise<void> {
    if (!this._canStart()) {
      resolution.nudgePending = true;
      this._log.info({ issue: task.issueNumber, agent: resolution.agentId }, "merger reminder held: new Turns are on hold");
      return;
    }
    resolution.nudgePending = false;
    resolution.settling = false;
    this._log.info({ issue: task.issueNumber, agent: resolution.agentId }, "merger pushed nothing, reminder sent");
    try {
      await this._runner.send(resolution.agentId, mergerNudgeMessage(task), this._askHuman(task.issueNumber));
    } catch (error) {
      this._log.error({ err: error, issue: task.issueNumber, agent: resolution.agentId }, "merger reminder not sent");
      await this._deadEnd(task, "merge: conflict left unresolved", `Merger завершил Ход, не запушив ничего в PR #${task.pullNumber}, а напоминание ему не ушло: конфликт с \`${this._baseBranch}\` остался.`);
    }
  }

  // The ask_human handler bound to the Task, for a launch and for a resume of the Session.
  private _askHuman(issueNumber: IssueNumber): { onAskHuman?: (call: AskHumanCall) => ReturnType<AskHumanHandler> } {
    const handler = this._onAskHuman;
    return handler ? { onAskHuman: (call) => handler(this._index.tasks.get(issueNumber), call) } : {};
  }

  private async _deadEnd(task: Task, reason: string, text: string): Promise<void> {
    this._resolutions.delete(task.issueNumber);
    await this._deadEnds.enter(task.issueNumber, reason, text);
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}

// The next message into the Implementer Session: which checks are red and what to do about it.
export const redChecksMessage = (task: Task, failure: MergeFailure & { kind: "red-checks" }): string =>
  [
    `Красные проверки CI на pull request #${task.pullNumber} (коммит \`${failure.sha}\`): ${failure.failed.join(", ")}.`,
    "",
    `Посмотри логи упавших checks (\`gh pr checks ${task.pullNumber}\`, \`gh run view\`), исправь причину, снова прогони тесты и линт, закоммить и запушь, затем ответь кратким списком «что исправлено».`,
  ].join("\n");

// The reminder into the Merger Session after a Turn that pushed nothing to the pull request.
export const mergerNudgeMessage = (task: Task): string =>
  `Ход завершён, но в PR #${task.pullNumber} ничего не запушено. Доведи слияние: дождись тестов в foreground, закоммить и запушь \`${task.branch}\`. Не уводи прогоны в фон.`;
