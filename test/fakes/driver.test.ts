import { describe, expect, it } from "vitest";
import { FakeDriverPort } from "../../src/fakes/driver.js";
import { sdkMessages } from "../../src/fakes/sdk-messages.js";
import type { SessionId } from "../../src/ids.js";

const SESSION = "11111111-1111-4111-8111-111111111111" as SessionId;

const collect = async (iterable: AsyncIterable<unknown>): Promise<unknown[]> => {
  const items: unknown[] = [];
  for await (const item of iterable) items.push(item);
  return items;
};

describe("FakeDriverPort", () => {
  it("records launches and streams messages the test emits", async () => {
    const driver = new FakeDriverPort();
    const process = driver.launch({ cwd: "/repo/.claude/worktrees/issue-1", prompt: "implement" });
    expect(driver.calls).toEqual([{ method: "launch", args: [{ cwd: "/repo/.claude/worktrees/issue-1", prompt: "implement" }] }]);
    expect(process.sessionId()).toBeUndefined();
    expect(process.pid()).toBe(1000);

    const received = collect(process.messages());
    const fake = driver.lastLaunch();
    fake.emit(sdkMessages.init(SESSION));
    expect(process.sessionId()).toBe(SESSION);
    fake.emit(sdkMessages.assistantText(SESSION, "done"));
    fake.emit(sdkMessages.resultSuccess(SESSION, "done"));
    fake.end();

    const types = (await received).map((message) => (message as { type: string }).type);
    expect(types).toEqual(["system", "assistant", "result"]);
    expect(await process.exited()).toEqual({ code: 0, signal: null });
    expect(process.pid()).toBeUndefined();
  });

  it("replays a scripted launch and closes the stream", async () => {
    const driver = new FakeDriverPort();
    driver.scriptNextLaunch([sdkMessages.init(SESSION), sdkMessages.resultSuccess(SESSION, "ok")]);
    const process = driver.launch({ cwd: "/w", prompt: "go" });
    expect((await collect(process.messages())).length).toBe(2);
    expect(process.sessionId()).toBe(SESSION);
  });

  it("keeps the session id on resume and records send, interrupt and stop", async () => {
    const driver = new FakeDriverPort();
    const process = driver.launch({ cwd: "/w", resume: SESSION });
    expect(process.sessionId()).toBe(SESSION);
    await process.send("continue");
    await process.interrupt();
    expect(await process.stop()).toEqual({ code: null, signal: "SIGTERM" });
    const fake = driver.lastLaunch();
    expect(fake.sent).toEqual(["continue"]);
    expect(fake.log.methods()).toEqual(["send", "interrupt", "stop"]);
    await expect(process.send("late")).rejects.toThrow("exited");
  });

  it("routes ask_human decisions through the launch handler", async () => {
    const driver = new FakeDriverPort();
    const seen: string[] = [];
    driver.launch({
      cwd: "/w",
      prompt: "ask",
      onAskHuman: async (call) => {
        seen.push(call.question);
        return { kind: "defer" };
      },
    });
    expect(await driver.lastLaunch().askHuman({ toolUseId: "toolu_1", question: "Which colour?", options: ["red"] })).toEqual({
      kind: "defer",
    });
    expect(seen).toEqual(["Which colour?"]);
  });

  it("serves session history and the claude version", async () => {
    const driver = new FakeDriverPort();
    driver.histories.set(SESSION, [sdkMessages.init(SESSION)]);
    expect(await driver.getSessionHistory(SESSION)).toHaveLength(1);
    expect(await driver.getSessionHistory("other" as SessionId)).toEqual([]);
    expect(await driver.getClaudeVersion()).toBe("2.1.318");
    expect(driver.log.methods()).toEqual(["getSessionHistory", "getSessionHistory", "getClaudeVersion"]);
  });
});
