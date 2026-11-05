import type { IntentId, IssueNumber } from "../ids.js";
import type { Intent } from "../index/intents.js";
import type { RuntimeIndex } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/clock.js";

// A kind of external action. `P` is the JSON payload stored with the intent, `R` the JSON result
// stored once it is done. The phantom fields only carry the types.
export type IntentKind<P, R = void> = {
  readonly name: string;
  readonly __payload?: P;
  readonly __result?: R;
};

export const defineIntent = <P, R = void>(name: string): IntentKind<P, R> => ({ name });

// Performs the action. It must be idempotent: on recovery it runs again for an intent whose action may
// already have happened, so it checks what exists (PR for the branch, worktree, marked comment) before creating.
export type IntentHandler<P, R> = (payload: P, intent: Intent) => Promise<R>;

export type RecoverSummary = { completed: number; failed: number };

export class UnknownIntentError extends Error {
  constructor(readonly kind: string) {
    super(`no handler for intent kind "${kind}"`);
    this.name = "UnknownIntentError";
  }
}

export type IntentJournalOptions = {
  index: RuntimeIndex;
  log: Logger;
  clock: Clock;
};

// Journal of external actions: an intent is written before the action and marked done after, so a crash
// in between leaves a pending row that `recover()` finishes exactly once more.
export class IntentJournal {
  private readonly _index: RuntimeIndex;
  private readonly _log: Logger;
  private readonly _clock: Clock;
  private readonly _handlers = new Map<string, IntentHandler<unknown, unknown>>();
  private readonly _inFlight = new Set<IntentId>();

  constructor(options: IntentJournalOptions) {
    this._index = options.index;
    this._log = options.log;
    this._clock = options.clock;
  }

  handle<P, R>(kind: IntentKind<P, R>, handler: IntentHandler<P, R>): void {
    this._handlers.set(kind.name, handler as IntentHandler<unknown, unknown>);
  }

  // Records the intent, performs it and marks it done. A failed action stays pending for `recover()`.
  async run<P, R>(kind: IntentKind<P, R>, issueNumber: IssueNumber, payload: P): Promise<R> {
    if (!this._handlers.has(kind.name)) throw new UnknownIntentError(kind.name);
    const intent = this._index.intents.add({ kind: kind.name, issueNumber, payload }, this._iso());
    return (await this._perform(intent)) as R;
  }

  // Finishes every pending intent, oldest first. Intents already running are left alone.
  async recover(): Promise<RecoverSummary> {
    const summary: RecoverSummary = { completed: 0, failed: 0 };
    for (const listed of this._index.intents.listPending()) {
      if (this._inFlight.has(listed.id)) continue;
      // Another caller may have finished it while this loop was waiting on an earlier intent.
      const intent = this._index.intents.find(listed.id);
      if (intent === undefined || intent.state !== "pending") continue;
      try {
        await this._perform(intent);
        summary.completed += 1;
      } catch (error) {
        summary.failed += 1;
        this._log.error({ err: error, intent: intent.id, kind: intent.kind, issue: intent.issueNumber }, "intent failed");
      }
    }
    return summary;
  }

  pending(): Intent[] {
    return this._index.intents.listPending();
  }

  private async _perform(intent: Intent): Promise<unknown> {
    const handler = this._handlers.get(intent.kind);
    if (!handler) throw new UnknownIntentError(intent.kind);
    this._inFlight.add(intent.id);
    try {
      this._log.debug({ intent: intent.id, kind: intent.kind, issue: intent.issueNumber }, "intent started");
      const result = await handler(intent.payload, intent);
      this._index.intents.markDone(intent.id, result, this._iso());
      this._log.debug({ intent: intent.id, kind: intent.kind, issue: intent.issueNumber }, "intent done");
      return result;
    } finally {
      this._inFlight.delete(intent.id);
    }
  }

  private _iso(): string {
    return new Date(this._clock.now()).toISOString();
  }
}
