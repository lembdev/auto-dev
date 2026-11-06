import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../agents/agent-runner.js";
import type { AgentId, IssueNumber } from "../ids.js";
import type { AgentRecord } from "../index/agents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task, TaskStage } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import type { AskHumanCall } from "../ports/driver.js";
import type { GitHubPort, Issue } from "../ports/github.js";
import { StagePrompts } from "../prompts/index.js";
import type { DeadEnds } from "./dead-end.js";
import { findEpic } from "./epic.js";
import type { AskHumanHandler, Implementation } from "./implementation.js";
import { isTurnEnd } from "./turns.js";
import { formatBlockers, formatVerdict, parseVerdict, type Verdict } from "./verdict.js";

export const DEFAULT_MAX_QA_ROUNDS = 3;
// Key in the `installation` table.
export const MAX_QA_ROUNDS_KEY = "max_qa_rounds";

// Sent into the same QA Session when its last message holds no single verdict JSON.
export const VERDICT_RETRY_PROMPT =
  'Твой последний ответ не содержит ровно один JSON вердикта. Ответь одним сообщением, в котором только JSON вида {"approved": boolean, "summary": string, "blockers": [{"where": string, "what": string}]} без другого текста, без пояснений и без code fence.';

// How many verdicts in a row may fail to parse (or Turns fail) within one round before the dead end.
const MAX_VERDICT_FAILURES = 2;

export { DEAD_END, type DeadEndPayload, type DeadEndResult } from "./dead-end.js";

export type QaStageOptions = {
  github: GitHubPort;
  runner: AgentRunner;
  index: RuntimeIndex;
  log: Logger;
  clock: Clock;
  deadEnds: DeadEnds;
  implementation: Implementation;
  prompts?: StagePrompts;
  transition: (issueNumber: IssueNumber, to: TaskStage, reason?: string) => Task;
  findIssue: (issueNumber: IssueNumber) => Promise<Issue>;
  // False while the Installation is paused or at the limit: no new round starts, running Turns finish.
  canStartRound?: () => boolean;
  onAskHuman?: AskHumanHandler;
};

// One QA check of one attempt. It lives in memory only: a QA Session is disposable, so after a restart
// the Task in `qa` simply gets a fresh round through `startRounds()`.
type Round = {
  attempt: number;
  round: number;
  agentId: AgentId;
  failures: number;
  lastText: string;
  // A verdict is being acted on; the round is done once it settles.
  settling: boolean;
};


// The QA Stage: every round starts a new QA Agent with a clean Session in the worktree, its verdict
// moves the Task on (blockers back to the Implementer, approval to merge) or into a dead end.
export class QaStage {
  private readonly _github: GitHubPort;
  private readonly _runner: AgentRunner;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _clock: Clock;
  private readonly _deadEnds: DeadEnds;
  private readonly _implementation: Implementation;
  private readonly _prompts: StagePrompts;
  private readonly _transition: QaStageOptions["transition"];
  private readonly _findIssue: QaStageOptions["findIssue"];
  private readonly _canStartRound: () => boolean;
  private readonly _onAskHuman: AskHumanHandler | undefined;
  private readonly _rounds = new Map<IssueNumber, Round>();
  private readonly _lastVerdicts = new Map<IssueNumber, Verdict>();
  private readonly _starting = new Set<IssueNumber>();

  constructor(options: QaStageOptions) {
    this._github = options.github;
    this._runner = options.runner;
    this._index = options.index;
    this._log = options.log;
    this._clock = options.clock;
    this._deadEnds = options.deadEnds;
    this._implementation = options.implementation;
    this._prompts = options.prompts ?? new StagePrompts();
    this._transition = options.transition;
    this._findIssue = options.findIssue;
    this._canStartRound = options.canStartRound ?? (() => true);
    this._onAskHuman = options.onAskHuman;
    this._runner.onMessage((agent, message) => this._observe(agent, message));
  }

  maxRounds(): number {
    const raw = this._index.installation.find(MAX_QA_ROUNDS_KEY);
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_QA_ROUNDS;
  }

  // The QA Agent checking the Task right now, if a round is in progress.
  findReviewer(task: Task): AgentRecord | undefined {
    const round = this._rounds.get(task.issueNumber);
    return round ? this._index.agents.find(round.agentId) : undefined;
  }

  // The round in progress is the extra one after a Merger: the Task came to `qa` from `merge`, which no
  // other path does. It is read from `transitions`, so it survives a restart.
  isExtraRound(issueNumber: IssueNumber): boolean {
    const last = this._index.transitions.listFor(issueNumber).at(-1);
    return last?.from === "merge" && last.to === "qa";
  }

  // The verdict of the last finished round of the Task, as long as the Orchestrator has been running.
  findLastVerdict(issueNumber: IssueNumber): Verdict | undefined {
    const verdict = this._lastVerdicts.get(issueNumber);
    return verdict ? structuredClone(verdict) : undefined;
  }

  // Starts a round for every Task in `qa` that has none: right after the Implementer's Turn, after a
  // restart, once the Pause is lifted or when an earlier launch failed.
  async startRounds(): Promise<void> {
    for (const task of this._index.tasks.listByStage(["qa"])) {
      await this.ensureRound(task.issueNumber);
    }
  }

  // Starts the round of the Task unless one is already running or new rounds may not start now.
  async ensureRound(issueNumber: IssueNumber): Promise<AgentRecord | undefined> {
    const task = this._index.tasks.find(issueNumber);
    if (!task || task.stage !== "qa" || this._starting.has(issueNumber)) return undefined;
    const current = this._rounds.get(issueNumber);
    if (current && current.attempt === task.attempt && current.round === task.round) {
      if (current.settling || this._runner.isLive(current.agentId)) return this._index.agents.find(current.agentId);
      // The process is gone without a verdict (crash, orphan after a restart): the round starts over.
      this._log.warn({ issue: issueNumber, agent: current.agentId }, "qa process gone without a verdict");
      this._rounds.delete(issueNumber);
    }
    if (!this._canStartRound()) {
      this._log.debug({ issue: issueNumber }, "qa round not started: new Turns are on hold");
      return undefined;
    }
    this._starting.add(issueNumber);
    try {
      return await this._start(task);
    } finally {
      this._starting.delete(issueNumber);
    }
  }

  private async _start(task: Task): Promise<AgentRecord | undefined> {
    if (task.worktreePath === null || task.branch === null) return undefined;
    const issue = await this._findIssue(task.issueNumber);
    const epic = await findEpic(this._github, issue);
    const previous = this._lastVerdicts.get(task.issueNumber);
    const prompt = this._prompts.render({
      stage: "qa",
      issue,
      epic,
      pullNumber: task.pullNumber,
      branch: task.branch,
      worktree: task.worktreePath,
      round: task.round + 1,
      ...(previous ? { previousVerdict: formatVerdict(previous) } : {}),
    });
    const agent = this._runner.start({
      issueNumber: task.issueNumber,
      role: "qa",
      cwd: task.worktreePath,
      prompt,
      ...(this._onAskHuman
        ? { onAskHuman: (call: AskHumanCall) => this._onAskHuman!(this._index.tasks.get(task.issueNumber), call) }
        : {}),
    });
    this._rounds.set(task.issueNumber, {
      attempt: task.attempt,
      round: task.round,
      agentId: agent.id,
      failures: 0,
      lastText: "",
      settling: false,
    });
    this._log.info({ issue: task.issueNumber, agent: agent.id, round: task.round + 1, max: this.maxRounds() }, "qa round started");
    return agent;
  }

  private _observe(agent: AgentRecord, message: SDKMessage): void {
    if (agent.issueNumber === null) return;
    if (agent.role === "implementer") {
      if (!isTurnEnd(message)) return;
      // The Implementation Stage has just moved the Task to `qa` when its Turn finished cleanly.
      this._fireAndLog(agent.issueNumber, this.ensureRound(agent.issueNumber), "qa round not started");
      return;
    }
    if (agent.role !== "qa") return;
    const round = this._rounds.get(agent.issueNumber);
    if (!round || round.agentId !== agent.id || round.settling) return;
    if (message.type === "assistant") {
      const text = message.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
      if (text !== "") round.lastText = text;
      return;
    }
    if (!isTurnEnd(message) || message.type !== "result") return;
    const text = message.subtype === "success" && message.result.trim() !== "" ? message.result : round.lastText;
    const verdict = message.is_error ? undefined : parseVerdict(text);
    if (verdict) {
      round.settling = true;
      this._fireAndLog(agent.issueNumber, this._settle(agent.issueNumber, round, verdict), "qa verdict not applied");
      return;
    }
    round.failures += 1;
    const why = message.is_error ? "qa turn failed" : "qa verdict unparsable";
    this._log.warn({ issue: agent.issueNumber, agent: agent.id, failures: round.failures, subtype: message.subtype }, why);
    if (round.failures >= MAX_VERDICT_FAILURES) {
      round.settling = true;
      const reason = message.is_error ? "qa turn failed twice" : "qa verdict unparsable twice";
      const explanation = message.is_error
        ? "Ход QA дважды подряд завершился ошибкой."
        : `QA дважды подряд не выдал вердикт в формате JSON. Последний ответ:\n\n${text.trim() || "(пусто)"}`;
      this._fireAndLog(agent.issueNumber, this._deadEnd(agent.issueNumber, reason, explanation), "dead end not recorded");
      return;
    }
    if (message.is_error) {
      // The Session produced nothing to repeat; a fresh one checks again, the failure count carries over.
      this._rounds.delete(agent.issueNumber);
      this._fireAndLog(agent.issueNumber, this._restart(agent.id, agent.issueNumber, round.failures), "qa round not restarted");
      return;
    }
    // The same Session already did the review; it only has to answer with the JSON.
    this._fireAndLog(agent.issueNumber, this._runner.send(agent.id, VERDICT_RETRY_PROMPT), "verdict retry not sent");
  }

  private async _restart(previous: AgentId, issueNumber: IssueNumber, failures: number): Promise<void> {
    await this._runner.stop(previous);
    await this.ensureRound(issueNumber);
    const round = this._rounds.get(issueNumber);
    if (round) round.failures = failures;
  }

  private async _settle(issueNumber: IssueNumber, round: Round, verdict: Verdict): Promise<void> {
    this._lastVerdicts.set(issueNumber, verdict);
    await this._runner.stop(round.agentId);
    const task = this._index.tasks.get(issueNumber);
    const checked = task.round + 1;
    // The extra round after a Merger is not counted: the Task keeps its round and the limit stays out of it.
    const extra = this.isExtraRound(issueNumber);
    const label = extra ? "qa extra round" : `qa round ${checked}`;
    if (verdict.approved) {
      this._rounds.delete(issueNumber);
      this._transition(issueNumber, "merge", `${label}: approved`);
      this._log.info({ issue: issueNumber, round: checked, extra }, "qa approved");
      return;
    }
    const max = this.maxRounds();
    if (!extra && checked >= max) {
      await this._deadEnd(
        issueNumber,
        `qa rounds exhausted: ${checked} of ${max}`,
        `Исчерпан лимит Кругов QA (${checked} из ${max}). Последний вердикт:\n\n${formatVerdict(verdict)}`,
      );
      return;
    }
    this._rounds.delete(issueNumber);
    if (!extra) this._index.tasks.update(issueNumber, { round: checked }, this._iso());
    this._transition(issueNumber, "implement", `${label}: ${verdict.blockers.length} blockers`);
    await this._implementation.send(issueNumber, formatBlockers(verdict));
    this._log.info({ issue: issueNumber, round: checked, blockers: verdict.blockers.length }, "qa blockers sent to the implementer");
  }

  private async _deadEnd(issueNumber: IssueNumber, reason: string, text: string): Promise<void> {
    this._rounds.delete(issueNumber);
    await this._deadEnds.enter(issueNumber, reason, text);
  }

  private _fireAndLog(issueNumber: IssueNumber, work: Promise<unknown>, failure: string): void {
    work.catch((error: unknown) => this._log.error({ err: error, issue: issueNumber }, failure));
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}
