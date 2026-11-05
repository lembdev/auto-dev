import { afterEach, describe, expect, it } from "vitest";
import { createFakePorts } from "../../src/fakes/index.js";
import type { IssueNumber } from "../../src/ids.js";
import { IN_MEMORY, openRuntimeIndex, type RuntimeIndex } from "../../src/index/runtime-index.js";
import { createLogger } from "../../src/log.js";
import { AUTO_DEV_MARKER, commentMarker, isMarkedComment, Orchestrator } from "../../src/orchestrator/index.js";
import { defineIntent, IntentJournal, UnknownIntentError } from "../../src/orchestrator/intents.js";

const log = createLogger({ level: "silent" });
const REPO = "/var/lib/auto-dev/repo";

describe("IntentJournal", () => {
  const indexes: RuntimeIndex[] = [];
  afterEach(() => {
    for (const index of indexes.splice(0)) index.close();
  });

  const journal = (index: RuntimeIndex) => new IntentJournal({ index, log, clock: createFakePorts().clock });

  it("runs a handler between the pending and done marks and hands back its result", async () => {
    const index = openRuntimeIndex(IN_MEMORY);
    indexes.push(index);
    const ping = defineIntent<{ value: number }, { doubled: number }>("ping");
    const states: string[][] = [];
    const j = journal(index);
    j.handle(ping, async (payload) => {
      states.push(index.intents.listPending().map((intent) => `${intent.kind}:${intent.state}`));
      return { doubled: payload.value * 2 };
    });

    const result = await j.run(ping, 1 as IssueNumber, { value: 21 });

    expect(result).toEqual({ doubled: 42 });
    expect(states).toEqual([["ping:pending"]]);
    expect(index.intents.listFor(1 as IssueNumber)).toEqual([
      expect.objectContaining({ kind: "ping", payload: { value: 21 }, state: "done", result: { doubled: 42 } }),
    ]);
  });

  it("leaves the intent pending when the handler throws and completes it on recover", async () => {
    const index = openRuntimeIndex(IN_MEMORY);
    indexes.push(index);
    const flaky = defineIntent<{ n: number }>("flaky");
    let attempts = 0;
    const j = journal(index);
    j.handle(flaky, async () => {
      if (attempts++ === 0) throw new Error("boom");
    });

    await expect(j.run(flaky, 2 as IssueNumber, { n: 1 })).rejects.toThrow("boom");
    expect(index.intents.listPending()).toHaveLength(1);

    expect(await j.recover()).toEqual({ completed: 1, failed: 0 });
    expect(index.intents.listPending()).toEqual([]);
    expect(attempts).toBe(2);
  });

  it("recovers oldest first, skips intents already in flight and reports unknown kinds as failed", async () => {
    const index = openRuntimeIndex(IN_MEMORY);
    indexes.push(index);
    const now = "2026-01-01T00:00:00.000Z";
    index.intents.add({ kind: "stranger", issueNumber: 9 as IssueNumber, payload: {} }, now);
    index.intents.add({ kind: "slow", issueNumber: 9 as IssueNumber, payload: { id: "a" } }, now);
    index.intents.add({ kind: "slow", issueNumber: 9 as IssueNumber, payload: { id: "b" } }, now);
    const slow = defineIntent<{ id: string }>("slow");
    const order: string[] = [];
    const j = journal(index);
    let release: () => void = () => {};
    j.handle(slow, async (payload) => {
      order.push(payload.id);
      if (payload.id === "a") await new Promise<void>((resolve) => (release = resolve));
    });

    const firstRecover = j.recover();
    await new Promise((resolve) => setImmediate(resolve));
    // While "a" is still running, a second recover must not start it again.
    const secondRecover = j.recover();
    release();
    const [first, second] = await Promise.all([firstRecover, secondRecover]);
    expect(first.completed + second.completed).toBe(2);
    expect([first.failed, second.failed]).toEqual([1, 1]);
    expect(order).toEqual(["a", "b"]);
    expect(index.intents.listPending().map((intent) => intent.kind)).toEqual(["stranger"]);
  });

  it("rejects running an intent nobody handles", async () => {
    const index = openRuntimeIndex(IN_MEMORY);
    indexes.push(index);
    const nobody = defineIntent<Record<string, never>>("nobody");
    await expect(journal(index).run(nobody, 1 as IssueNumber, {})).rejects.toThrow(UnknownIntentError);
    expect(index.intents.list()).toEqual([]);
  });
});

describe("marked comments", () => {
  it("posts a comment with the auto-dev marker once, even after a crash before the done mark", async () => {
    const ports = createFakePorts();
    ports.worktree.seedRepo(REPO);
    const index = openRuntimeIndex(IN_MEMORY);
    const github = ports.github;
    github.seedIssue({ number: 4 });
    const originalCreate = github.createIssueComment.bind(github);
    github.createIssueComment = async (number, body) => {
      await originalCreate(number, body);
      throw new Error("process died");
    };
    const first = new Orchestrator({ ports, index, log, product: { repoPath: REPO } });
    await expect(first.postComment(4 as IssueNumber, "request:1", "Which database?")).rejects.toThrow("process died");
    expect(github.commentsOf(4)).toHaveLength(1);
    expect(index.intents.listPending().map((intent) => intent.kind)).toEqual(["post-comment"]);

    github.createIssueComment = originalCreate;
    const second = new Orchestrator({ ports, index, log, product: { repoPath: REPO } });
    await second.pollOnce();

    const comments = github.commentsOf(4);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(`Which database?\n\n${AUTO_DEV_MARKER}\n${commentMarker("request:1")}`);
    expect(isMarkedComment(comments[0]?.body ?? "", "request:1")).toBe(true);
    expect(isMarkedComment(comments[0]?.body ?? "", "request:2")).toBe(false);
    expect(index.intents.listFor(4 as IssueNumber)).toEqual([
      expect.objectContaining({ kind: "post-comment", state: "done", result: { commentId: comments[0]?.id } }),
    ]);
    second.stop();
    index.close();
  });

  it("returns the existing comment when the same key is posted twice", async () => {
    const ports = createFakePorts();
    ports.worktree.seedRepo(REPO);
    const index = openRuntimeIndex(IN_MEMORY);
    ports.github.seedIssue({ number: 4 });
    const orchestrator = new Orchestrator({ ports, index, log, product: { repoPath: REPO } });

    const a = await orchestrator.postComment(4 as IssueNumber, "final", "Merged.");
    const b = await orchestrator.postComment(4 as IssueNumber, "final", "Merged again.");

    expect(b.id).toBe(a.id);
    expect(ports.github.commentsOf(4)).toHaveLength(1);
    expect(ports.github.calls.filter((call) => call.method === "createIssueComment")).toHaveLength(1);
    index.close();
  });
});
