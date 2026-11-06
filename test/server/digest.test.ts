import { afterEach, describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL_NAME } from "../../src/adapters/ask-human.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { IssueNumber, SessionId, ToolUseId } from "../../src/ids.js";
import type { DigestResponse } from "../../src/server/app.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

const SESSION = "33333333-3333-4333-8333-333333333333" as SessionId;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("GET /api/digest", () => {
  let testApp: TestApp;
  afterEach(async () => {
    await testApp?.orchestrator.shutdown();
    testApp?.close();
  });

  const digest = async (since: string): Promise<DigestResponse> => {
    const response = await testApp.request(`/api/digest?since=${encodeURIComponent(since)}`);
    expect(response.status).toBe(200);
    return (await response.json()) as DigestResponse;
  };

  it("requires an ISO `since`", async () => {
    testApp = createTestApp();
    expect((await testApp.request("/api/digest")).status).toBe(400);
    expect((await testApp.request("/api/digest?since=yesterday")).status).toBe(400);
  });

  it("lists Requests, finished Tasks and dead ends since the previous visit, once per Task", async () => {
    testApp = createTestApp();
    testApp.index.installation.set("max_parallel_tasks", "3");
    const { github, clock, driver } = testApp.ports;
    github.seedIssue({ number: 1, title: "One", labels: ["ready-for-agent"] });
    github.seedIssue({ number: 2, title: "Two", labels: ["ready-for-agent"] });
    github.seedIssue({ number: 3, title: "Three", labels: ["ready-for-agent"] });
    await testApp.orchestrator.pollOnce();
    const visit = new Date(clock.now()).toISOString();
    await clock.advance(60_000);

    testApp.orchestrator.transition(1 as IssueNumber, "qa");
    testApp.orchestrator.transition(1 as IssueNumber, "merge");
    testApp.orchestrator.transition(1 as IssueNumber, "done");
    const doneAt = new Date(clock.now()).toISOString();
    await clock.advance(60_000);
    testApp.orchestrator.transition(2 as IssueNumber, "stuck", "qa verdict unparsable twice");
    const stuckAt = new Date(clock.now()).toISOString();
    await clock.advance(60_000);

    const third = driver.launches[2]!;
    third.emit(sdkMessages.init(SESSION));
    third.emit(
      sdkMessages.resultSuccess(SESSION, "", {
        stop_reason: "tool_deferred",
        terminal_reason: "tool_deferred",
        deferred_tool_use: { id: "toolu_3", name: ASK_HUMAN_TOOL_NAME, input: { question: "Keep the old import?\nIt has 14 rows.", options: ["yes", "no"] } },
      }),
    );
    third.end();
    await flush();
    const askedAt = new Date(clock.now()).toISOString();

    expect(await digest(visit)).toEqual({
      since: visit,
      requests: [{ id: 1, issueNumber: 3, title: "Three", createdAt: askedAt, open: true, question: "Keep the old import?\nIt has 14 rows." }],
      done: [{ issueNumber: 1, title: "One", pullNumber: 1, pullUrl: "https://github.com/example/product/pull/1", at: doneAt }],
      stuck: [{ issueNumber: 2, title: "Two", reason: "qa verdict unparsable twice", at: stuckAt }],
    });

    // A visit after everything happened sees nothing; the Request answered meanwhile is listed as closed.
    expect(await digest(new Date(clock.now()).toISOString())).toEqual({ since: new Date(clock.now()).toISOString(), requests: [], done: [], stuck: [] });
    github.humanComment(3, "yes", "alice");
    await testApp.orchestrator.pollOnce();
    const resumed = driver.lastLaunch();
    await resumed.askHuman({ toolUseId: "toolu_3" as ToolUseId, question: "Keep the old import?", options: ["yes", "no"] });
    expect((await digest(visit)).requests).toEqual([expect.objectContaining({ id: 1, open: false })]);
  });
});
