import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASK_HUMAN_TOOL, NO_ANSWER_TEXT, formatAskHumanResult } from "../../src/adapters/ask-human.js";

const root = path.resolve(import.meta.dirname, "..", "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const server = path.join(root, "src", "adapters", "ask-human-mcp.ts");

type ToolResult = { content: { type: string; text?: string }[] };

describe("ask_human stdio server", () => {
  const client = new Client({ name: "test", version: "0.0.0" });

  beforeAll(async () => {
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [tsx, server], env: { PATH: process.env.PATH ?? "" } }),
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it("exposes the ask_human tool with question and options", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([ASK_HUMAN_TOOL]);
    const schema = tools[0]?.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["answer", "options", "question", "source"]);
    expect(schema.required).toEqual(["question"]);
  });

  it("returns the Answer with its source as the tool result", async () => {
    const result = (await client.callTool({
      name: ASK_HUMAN_TOOL,
      arguments: { question: "Which colour?", options: ["red", "blue"], answer: "blue", source: "alice in issue #7" },
    })) as ToolResult;
    expect(result.content).toEqual([{ type: "text", text: "blue\n\n(answered by alice in issue #7)" }]);
  });

  it("tells the Agent when no Answer was delivered", async () => {
    const result = (await client.callTool({ name: ASK_HUMAN_TOOL, arguments: { question: "Which colour?" } })) as ToolResult;
    expect(result.content).toEqual([{ type: "text", text: NO_ANSWER_TEXT }]);
  });
});

describe("formatAskHumanResult", () => {
  it("omits the source line when unknown", () => {
    expect(formatAskHumanResult({ question: "q", answer: "yes" })).toBe("yes");
  });
});
