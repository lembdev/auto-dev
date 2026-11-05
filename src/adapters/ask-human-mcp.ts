#!/usr/bin/env node
// Stdio MCP server with the single `ask_human` tool. It only echoes the Answer the Orchestrator
// put into the tool input on resume: the deciding logic lives in the PreToolUse hook of the Driver.
// Runs as a separate process because an in-process SDK server cannot serve a deferred call after resume.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ASK_HUMAN_DESCRIPTION, ASK_HUMAN_SERVER, ASK_HUMAN_TOOL, formatAskHumanResult } from "./ask-human.js";

export function createAskHumanServer(): McpServer {
  const server = new McpServer({ name: ASK_HUMAN_SERVER, version: "1.0.0" });
  server.registerTool(
    ASK_HUMAN_TOOL,
    {
      description: ASK_HUMAN_DESCRIPTION,
      inputSchema: {
        question: z.string().describe("The question for the human"),
        options: z.array(z.string()).optional().describe("Suggested answers, if any"),
        answer: z.string().optional().describe("Internal: filled by the orchestrator when the human answers"),
        source: z.string().optional().describe("Internal: who answered and where"),
      },
    },
    async (input) => ({ content: [{ type: "text", text: formatAskHumanResult(input) }] }),
  );
  return server;
}

async function serve(): Promise<void> {
  await createAskHumanServer().connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  serve().catch((error: unknown) => {
    process.stderr.write(`ask_human server failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
