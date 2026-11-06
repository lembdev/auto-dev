import type { TaskStage, Transition } from "../index/tasks.js";

// The Stages whose time the statistics page shows; `taken` is only the gap before the Implementer starts.
export const TIMED_STAGES = ["implement", "qa", "merge"] as const;
export type TimedStage = (typeof TIMED_STAGES)[number];

export type StageTime = {
  stage: TimedStage;
  // How many stays in the Stage ended inside the period.
  count: number;
  meanMs: number | null;
  medianMs: number | null;
};

export type RoundsBucket = { rounds: number; tasks: number };

export type RoundsDistribution = {
  // Attempts that ended in `done` or `stuck` inside the period.
  tasks: number;
  mean: number | null;
  buckets: RoundsBucket[];
};

export type TaskStats = {
  taken: number;
  done: number;
  stuck: number;
  stages: StageTime[];
  rounds: RoundsDistribution;
};

const isTimedStage = (stage: TaskStage | null): stage is TimedStage => (TIMED_STAGES as readonly string[]).includes(stage ?? "");

const mean = (values: number[]): number | null => (values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

// Aggregates the Stage history over the window [since, +inf). A stay in a Stage belongs to the period in
// which it ended; an attempt's Rounds count where the attempt ended. `transitions` must be in append order.
export function computeTaskStats(transitions: readonly Transition[], since: string): TaskStats {
  let taken = 0;
  let done = 0;
  let stuck = 0;
  const durations: Record<TimedStage, number[]> = { implement: [], qa: [], merge: [] };
  const roundsPerAttempt: number[] = [];
  // Per issue: when the current Stage started, and how many QA Rounds the current attempt had.
  const current = new Map<number, { stage: TaskStage; at: string; rounds: number }>();

  for (const transition of transitions) {
    const inPeriod = transition.at >= since;
    const previous = current.get(transition.issueNumber);
    if (previous && inPeriod && isTimedStage(previous.stage)) {
      durations[previous.stage].push(Math.max(0, Date.parse(transition.at) - Date.parse(previous.at)));
    }
    let rounds = previous?.rounds ?? 0;
    switch (transition.to) {
      case "taken":
        if (inPeriod) taken += 1;
        rounds = 0;
        break;
      case "qa":
        rounds += 1;
        break;
      case "done":
        if (inPeriod) {
          done += 1;
          roundsPerAttempt.push(rounds);
        }
        break;
      case "stuck":
        if (inPeriod) {
          stuck += 1;
          roundsPerAttempt.push(rounds);
        }
        break;
      default:
        break;
    }
    current.set(transition.issueNumber, { stage: transition.to, at: transition.at, rounds });
  }

  const byRounds = new Map<number, number>();
  for (const rounds of roundsPerAttempt) byRounds.set(rounds, (byRounds.get(rounds) ?? 0) + 1);
  const buckets = [...byRounds.entries()].sort((a, b) => a[0] - b[0]).map(([rounds, tasks]) => ({ rounds, tasks }));
  const roundsMean = roundsPerAttempt.length === 0 ? null : roundsPerAttempt.reduce((sum, value) => sum + value, 0) / roundsPerAttempt.length;

  return {
    taken,
    done,
    stuck,
    stages: TIMED_STAGES.map((stage) => ({ stage, count: durations[stage].length, meanMs: mean(durations[stage]), medianMs: median(durations[stage]) })),
    rounds: { tasks: roundsPerAttempt.length, mean: roundsMean, buckets },
  };
}
