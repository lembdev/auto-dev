// Standalone stdio MCP server exposing the same ask_human tool (name: mcp__human__ask_human when registered as "human").
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';

const logFile = process.env.PROTO_STDIO_LOG;
const log = (data) => logFile && fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), kind: 'stdio_tool_handler', ...data }) + '\n');

const server = new McpServer({ name: 'human', version: '0.0.1' });
server.registerTool(
  'ask_human',
  {
    description: 'Ask the human operator a question. Blocks until the human answers.',
    inputSchema: {
      question: z.string(),
      options: z.array(z.string()).optional(),
      answer: z.string().optional(),
    },
  },
  async (args) => {
    log({ args });
    const text = args.answer ? `Human answered: ${args.answer}` : 'No answer available yet.';
    return { content: [{ type: 'text', text }] };
  },
);
await server.connect(new StdioServerTransport());
