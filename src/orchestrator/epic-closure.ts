import { createHash } from "node:crypto";
import type { IssueNumber, MilestoneNumber, PullNumber } from "../ids.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Task } from "../index/tasks.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";
import { GitHubNotFoundError, type GitHubPort, type Issue, type IssueComment, type PullRequest } from "../ports/github.js";
import { parentNumberOf, parseChecklist } from "./epic.js";
import { defineIntent, type IntentJournal } from "./intents.js";
import { HUMAN_LABEL, READY_LABEL } from "./ready-tasks.js";

// Section of the pull request body where the Implementer copies the checklist lines of the Epic it closes.
export const EPIC_CRITERIA_HEADING = "## Критерии Epic";
// Organization issue types of the umbrella and the specification of a milestone.
export const EPIC_TYPE = "Epic";
export const SPEC_TYPE = "Spec";

const NO_CRITERIA = /^нет\.?$/iu;
const HEADING = /^#{1,6}\s/;
const BULLET = /^[-*]\s+(?:\[[ xX]\]\s+)?/;
const CHECKLIST_LINE = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*\S)\s*$/;

// Lines under `## Критерии Epic` up to the next heading, without bullets, checkboxes, blanks and «нет».
export function criteriaOfPullBody(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === EPIC_CRITERIA_HEADING);
  if (start === -1) return [];
  const criteria = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    const text = line.trim().replace(BULLET, "").trim();
    if (text === "" || NO_CRITERIA.test(text)) continue;
    criteria.add(text);
  }
  return [...criteria];
}

export type TickResult = { body: string; ticked: string[] };

// Puts `[x]` on every unchecked checklist line whose text equals one of `criteria`; nothing else changes.
export function tickCriteria(body: string, criteria: readonly string[]): TickResult {
  const wanted = new Set(criteria);
  const ticked = new Set<string>();
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/).map((line) => {
    const match = CHECKLIST_LINE.exec(line);
    if (!match || match[2] !== " " || !wanted.has(match[4] ?? "")) return line;
    ticked.add(match[4] ?? "");
    return `${match[1]}x${match[3]}${match[4]}`;
  });
  return { body: lines.join(newline), ticked: [...ticked] };
}

// How often the open milestones of merged Tasks are checked for what a human finished by hand.
export const MILESTONE_SWEEP_INTERVAL_MS = 10 * 60_000;

export type SettleEpicPayload = {
  pullNumber: PullNumber;
  // Parent of the Task; the Epic of a milestone without sub-issues is found by its type instead.
  parentNumber: IssueNumber | null;
  milestoneNumber: MilestoneNumber | null;
  criteria: string[];
};

export type MilestoneOutcome = "none" | "open-issues" | "unchecked-criteria" | "closed";

export type SettleEpicResult = {
  epicNumber: IssueNumber | null;
  ticked: string[];
  milestone: MilestoneOutcome;
};

// Ticks the criteria of a merged pull request in the Epic and closes the Epic, the Spec and the milestone
// once nothing is left; every step looks at the state first, so the intent may run again after a crash.
export const SETTLE_EPIC = defineIntent<SettleEpicPayload, SettleEpicResult>("settle-epic");

export type EpicClosureOptions = {
  github: GitHubPort;
  index: RuntimeIndex;
  log: Logger;
  clock: Clock;
  journal: IntentJournal;
  postComment: (issueNumber: IssueNumber, key: string, text: string) => Promise<IssueComment>;
  findIssue: (issueNumber: IssueNumber) => Promise<Issue>;
};

// What happens to the Epic and the milestone after the merge of a Task: the criteria the pull request
// names are ticked in the Epic; when every other issue of the milestone is closed, the Epic, the Spec and
// the milestone are closed too, or, with criteria still unchecked, the Epic goes to the human with a comment.
export class EpicClosure {
  private readonly _github: GitHubPort;
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _journal: IntentJournal;
  private readonly _postComment: EpicClosureOptions["postComment"];
  private readonly _findIssue: EpicClosureOptions["findIssue"];
  private readonly _clock: Clock;
  // Milestones seen closed; the sweep does not look at them again.
  private readonly _closedMilestones = new Set<MilestoneNumber>();
  private _lastSweep: number;
  private _sweeping = false;

  constructor(options: EpicClosureOptions) {
    this._github = options.github;
    this._index = options.index;
    this._log = options.log;
    this._journal = options.journal;
    this._postComment = options.postComment;
    this._findIssue = options.findIssue;
    this._clock = options.clock;
    this._lastSweep = this._clock.now();
    this._journal.handle(SETTLE_EPIC, (payload, intent) => this._settle(intent.issueNumber, payload));
  }

  // Runs once per merged pull request, after its issue is closed. A Task without a milestone and without
  // a parent has nothing to settle and costs no call.
  async settle(task: Task, pull: PullRequest): Promise<SettleEpicResult | undefined> {
    if (task.pullNumber === null) return undefined;
    const earlier = this._settled(task.issueNumber, task.pullNumber);
    if (earlier) return earlier;
    const issue = await this._findIssue(task.issueNumber);
    const parentNumber = parentNumberOf(issue) ?? null;
    const milestoneNumber = issue.milestone?.number ?? null;
    if (parentNumber === null && milestoneNumber === null) {
      this._log.debug({ issue: task.issueNumber }, "no epic and no milestone to settle");
      return undefined;
    }
    return this._journal.run(SETTLE_EPIC, task.issueNumber, {
      pullNumber: task.pullNumber,
      parentNumber,
      milestoneNumber,
      criteria: criteriaOfPullBody(pull.body),
    });
  }

  // A human may finish what a merge left open: tick the last criteria of the Epic or close the last issue.
  // Once per interval the open milestones of merged Tasks go through the same closure as after a merge;
  // every step looks at the state first, so a sweep with nothing to do changes nothing.
  async sweep(): Promise<void> {
    const now = this._clock.now();
    if (this._sweeping || now - this._lastSweep < MILESTONE_SWEEP_INTERVAL_MS) return;
    this._lastSweep = now;
    this._sweeping = true;
    try {
      const milestones = new Map<MilestoneNumber, IssueNumber>();
      for (const task of this._index.tasks.listByStage(["done"])) {
        if (task.milestone && !this._closedMilestones.has(task.milestone.number)) milestones.set(task.milestone.number, task.issueNumber);
      }
      for (const [milestoneNumber, issueNumber] of milestones) {
        try {
          await this._sweepMilestone(milestoneNumber, issueNumber);
        } catch (error) {
          this._log.error({ err: error, milestone: milestoneNumber }, "milestone not checked; the next sweep tries again");
        }
      }
    } finally {
      this._sweeping = false;
    }
  }

  private async _sweepMilestone(milestoneNumber: MilestoneNumber, issueNumber: IssueNumber): Promise<void> {
    const milestone = await this._github.getMilestone(milestoneNumber);
    if (milestone.state !== "open") {
      this._closedMilestones.add(milestoneNumber);
      return;
    }
    const members = await this._github.listIssues({ milestone: milestoneNumber, state: "all" });
    const task = members.find((member) => member.number === issueNumber);
    const parentNumber = (task && parentNumberOf(task)) ?? null;
    const epic = await this._findEpic(parentNumber, members);
    const outcome = await this._settleMilestone(issueNumber, milestoneNumber, epic, members);
    if (outcome === "closed") this._closedMilestones.add(milestoneNumber);
  }

  private _settled(issueNumber: IssueNumber, pullNumber: PullNumber): SettleEpicResult | undefined {
    const done = this._index.intents
      .listFor(issueNumber)
      .find((intent) => intent.kind === SETTLE_EPIC.name && intent.state === "done" && (intent.payload as SettleEpicPayload).pullNumber === pullNumber);
    return done ? (done.result as SettleEpicResult) : undefined;
  }

  private async _settle(issueNumber: IssueNumber, payload: SettleEpicPayload): Promise<SettleEpicResult> {
    const members = payload.milestoneNumber === null ? [] : await this._github.listIssues({ milestone: payload.milestoneNumber, state: "all" });
    let epic = await this._findEpic(payload.parentNumber, members);
    const ticked: string[] = [];
    if (epic && payload.criteria.length > 0) {
      const result = tickCriteria(epic.body, payload.criteria);
      if (result.ticked.length > 0) {
        epic = await this._github.updateIssue(epic.number, { body: result.body });
        ticked.push(...result.ticked);
        this._log.info({ issue: issueNumber, epic: epic.number, ticked }, "epic criteria ticked");
      }
    }
    const epicNumber = epic?.number ?? null;
    if (payload.milestoneNumber === null) return { epicNumber, ticked, milestone: "none" };
    const milestone = await this._settleMilestone(issueNumber, payload.milestoneNumber, epic, members);
    if (milestone === "closed") this._closedMilestones.add(payload.milestoneNumber);
    return { epicNumber, ticked, milestone };
  }

  // Closes the Epic, the Spec and the milestone once every other issue is closed and every criterion
  // ticked; with criteria left, the Epic goes to the human.
  private async _settleMilestone(issueNumber: IssueNumber, milestoneNumber: MilestoneNumber, epic: Issue | undefined, members: Issue[]): Promise<MilestoneOutcome> {
    const epicNumber = epic?.number ?? null;
    const specs = epic === undefined ? [] : members.filter((member) => this._isSpec(member, epic));
    const rest = members.filter((member) => member.number !== epicNumber && !specs.includes(member));
    const open = rest.filter((member) => member.state === "open");
    if (open.length > 0) {
      this._log.debug({ issue: issueNumber, milestone: milestoneNumber, open: open.map((member) => member.number) }, "milestone still has open issues");
      return "open-issues";
    }
    if (epic) {
      const unchecked = parseChecklist(epic.body)
        .filter((item) => !item.checked)
        .map((item) => item.text);
      if (unchecked.length > 0) {
        await this._handToHuman(epic, milestoneNumber, unchecked);
        return "unchecked-criteria";
      }
      if (epic.state === "open") await this._close(epic.number);
    }
    for (const spec of specs) {
      if (spec.state === "open") await this._close(spec.number);
    }
    const milestone = await this._github.getMilestone(milestoneNumber);
    if (milestone.state === "open") {
      await this._github.updateMilestone(milestoneNumber, { state: "closed" });
      this._log.info({ issue: issueNumber, milestone: milestoneNumber, epic: epicNumber, specs: specs.map((spec) => spec.number) }, "milestone closed");
    }
    return "closed";
  }

  // The parent of the Task is the Epic unless the repository has issue types and says otherwise; without
  // a parent the Epic is the issue of the milestone typed `Epic`, if any.
  private async _findEpic(parentNumber: IssueNumber | null, members: Issue[]): Promise<Issue | undefined> {
    if (parentNumber !== null) {
      const parent = members.find((member) => member.number === parentNumber) ?? (await this._findParent(parentNumber));
      if (parent && (parent.type === null || parent.type === EPIC_TYPE)) return parent;
    }
    return members.find((member) => member.type === EPIC_TYPE);
  }

  private async _findParent(number: IssueNumber): Promise<Issue | undefined> {
    try {
      return await this._github.getIssue(number);
    } catch (error) {
      if (error instanceof GitHubNotFoundError) return undefined;
      throw error;
    }
  }

  // With issue types the Spec is typed so. Without them it is an issue of the milestone next to the Epic that
  // is nobody's child, never opted in for the agent and never taken as a Task: in the layout of the Planner
  // that is the specification, while every Task hangs under the Epic.
  private _isSpec(issue: Issue, epic: Issue): boolean {
    if (issue.number === epic.number) return false;
    if (issue.type !== null) return issue.type === SPEC_TYPE;
    if (parentNumberOf(issue) !== undefined) return false;
    if (issue.labels.includes(READY_LABEL)) return false;
    return this._index.tasks.find(issue.number) === undefined;
  }

  private async _close(number: IssueNumber): Promise<void> {
    await this._github.updateIssue(number, { state: "closed", stateReason: "completed" });
    this._log.info({ issue: number }, "issue closed with the milestone");
  }

  // The label and the comment are put once per set of unchecked criteria: another merge that finds the
  // same lines unchecked adds nothing; a changed set gets a fresh comment.
  private async _handToHuman(epic: Issue, milestoneNumber: MilestoneNumber, unchecked: string[]): Promise<void> {
    if (!epic.labels.includes(HUMAN_LABEL)) await this._github.addLabels(epic.number, [HUMAN_LABEL]);
    const key = `epic-unchecked:${createHash("sha1").update(unchecked.join("\n")).digest("hex").slice(0, 12)}`;
    const milestone = epic.milestone?.title ?? `#${milestoneNumber}`;
    const text = [
      `Все issues вехи «${milestone}» закрыты, но в Epic не отмечены критерии:`,
      ...unchecked.map((line) => `- ${line}`),
      "",
      "Отметь их, если они выполнены, или заведи Задачи на остаток. Как только все критерии отмечены и все issues вехи закрыты, Оркестратор сам закроет Epic, Spec и веху (проверка раз в 10 минут).",
    ].join("\n");
    await this._postComment(epic.number, key, text);
    this._log.warn({ epic: epic.number, milestone: milestoneNumber, unchecked }, "epic handed to the human: criteria unchecked");
  }
}
