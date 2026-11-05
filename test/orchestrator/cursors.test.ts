import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePorts } from "../../src/fakes/index.js";
import { openRuntimeIndex } from "../../src/index/runtime-index.js";
import { createLogger } from "../../src/log.js";
import { INSTALLATION_KEYS, Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { IssueComment, PollQuery } from "../../src/ports/github.js";

const log = createLogger({ level: "silent" });

describe("polling cursors", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const dbPath = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-cursors-"));
    dirs.push(dir);
    return path.join(dir, "runtime.db");
  };

  it("stores since and ETag for both endpoints, moves them only on changes and keeps them across a restart", async () => {
    const file = dbPath();
    const ports = createFakePorts();
    const github = ports.github;
    github.seedIssue({ number: 1, labels: [] });

    const first = openRuntimeIndex(file);
    const orchestrator = new Orchestrator({ ports, index: first, log });
    await orchestrator.pollOnce();

    const after = first.installation.all();
    const issuesSince = after[INSTALLATION_KEYS.issuesSince];
    const issuesEtag = after[INSTALLATION_KEYS.issuesEtag];
    const commentsSince = after[INSTALLATION_KEYS.commentsSince];
    const commentsEtag = after[INSTALLATION_KEYS.commentsEtag];
    expect(issuesSince).toBe(github.issue(1).updatedAt);
    expect(issuesEtag).toMatch(/^".+"$/);
    expect(commentsEtag).toMatch(/^".+"$/);
    expect(commentsSince).toBeDefined();

    // Nothing changed: GitHub answers 304 and the cursors stay put.
    await ports.clock.advance(60_000);
    github.calls.length = 0;
    await orchestrator.pollOnce();
    expect(github.calls.find((call) => call.method === "pollIssues")?.args).toEqual([{ since: issuesSince, etag: issuesEtag }]);
    expect(github.calls.find((call) => call.method === "pollIssueComments")?.args).toEqual([
      { since: commentsSince, etag: commentsEtag },
    ]);
    expect(first.installation.all()).toEqual(after);
    first.close();

    // Restart on the same index: the stored cursors go straight into the first poll.
    await ports.clock.advance(60_000);
    github.humanComment(1, "hello");
    github.calls.length = 0;
    const second = openRuntimeIndex(file);
    const restarted = new Orchestrator({ ports, index: second, log });
    await restarted.pollOnce();
    expect(github.calls.find((call) => call.method === "pollIssues")?.args).toEqual([{ since: issuesSince, etag: issuesEtag }]);
    expect(github.calls.find((call) => call.method === "pollIssueComments")?.args).toEqual([
      { since: commentsSince, etag: commentsEtag },
    ]);
    const changed = second.installation.all();
    // The comment bumped the issue, so both cursors moved to the time of the change.
    const commentAt = github.commentsOf(1)[0]?.updatedAt;
    expect(changed[INSTALLATION_KEYS.issuesSince]).toBe(commentAt);
    expect(changed[INSTALLATION_KEYS.commentsSince]).toBe(commentAt);
    expect(changed[INSTALLATION_KEYS.issuesEtag]).not.toBe(issuesEtag);
    expect(changed[INSTALLATION_KEYS.commentsEtag]).not.toBe(commentsEtag);
    second.close();
  });

  it("hands updated comments to the hook oldest first and only once", async () => {
    const ports = createFakePorts();
    const github = ports.github;
    github.seedIssue({ number: 1 });
    const index = openRuntimeIndex(":memory:");
    const received: string[][] = [];
    const orchestrator = new Orchestrator({
      ports,
      index,
      log,
      hooks: {
        onIssueComments: async (comments: IssueComment[]) => {
          received.push(comments.map((comment) => comment.body));
        },
      },
    });
    await orchestrator.pollOnce();
    expect(received).toEqual([]);

    await ports.clock.advance(1_000);
    github.humanComment(1, "first");
    await ports.clock.advance(1_000);
    github.humanComment(1, "second");
    await orchestrator.pollOnce();
    expect(received).toEqual([["first", "second"]]);

    await orchestrator.pollOnce();
    expect(received).toEqual([["first", "second"]]);

    await ports.clock.advance(1_000);
    github.humanComment(1, "third");
    await orchestrator.pollOnce();
    expect(received).toEqual([["first", "second"], ["third"]]);

    // An edited comment counts as new; the untouched ones do not come back.
    await ports.clock.advance(1_000);
    github.humanEditComment(1, "first, edited");
    await orchestrator.pollOnce();
    expect(received).toEqual([["first", "second"], ["third"], ["first, edited"]]);
    index.close();
  });

  it("starts with since just before the first listing when the index has no cursor", async () => {
    const ports = createFakePorts();
    const index = openRuntimeIndex(":memory:");
    const orchestrator = new Orchestrator({ ports, index, log });
    await orchestrator.pollOnce();
    const query = ports.github.calls.find((call) => call.method === "pollIssues")?.args[0] as PollQuery;
    expect(Date.parse(query.since ?? "")).toBe(ports.clock.now() - 60_000);
    expect(query.etag).toBeUndefined();
    index.close();
  });
});
