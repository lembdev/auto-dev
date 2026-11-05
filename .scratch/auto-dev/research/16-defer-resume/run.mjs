// Prototype: ask_human via PreToolUse defer -> resume with the answer in updatedInput.
// Usage:
//   node run.mjs start                       # turn 1: model calls ask_human, hook defers
//   node run.mjs resume <sessionId> <answer> # turn 2: resume without prompt, hook allows with answer
//   node run.mjs resume-prompt <sessionId> <answer> # same but with a text prompt (to see the drop behaviour)
//   node run.mjs noq                         # check disallowedTools AskUserQuestion
//   node run.mjs sigterm                     # start a turn with Bash sleep, SIGTERM the claude child mid-turn
//   node run.mjs resume-interrupted <sessionId>  # resume with CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode = 'start', sessionArg, answerArg] = process.argv.slice(2);
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(here, `out-${mode}-${ts}.jsonl`);
const out = fs.createWriteStream(outFile);
const log = (kind, data) => {
  const line = JSON.stringify({ t: Date.now(), kind, ...data });
  out.write(line + '\n');
  const short = line.length > 600 ? line.slice(0, 600) + '…' : line;
  console.log(short);
};

const askHuman = tool(
  'ask_human',
  'Ask the human operator a question. Blocks until the human answers.',
  {
    question: z.string().describe('The question'),
    options: z.array(z.string()).optional().describe('Optional answer options'),
    answer: z.string().optional().describe('Internal: filled by the orchestrator on resume'),
  },
  async (args) => {
    log('tool_handler_called', { args });
    const text = args.answer ? `Human answered: ${args.answer}` : 'No answer available yet.';
    return { content: [{ type: 'text', text }] };
  },
);

const humanServer = createSdkMcpServer({ name: 'human', version: '0.0.1', tools: [askHuman], alwaysLoad: true });

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|ANTHROPIC_|CLAUDECODE)/.test(k))),
  ...(mode === 'resume-interrupted' ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1' } : {}),
};

const preToolUse = async (input, toolUseId, { signal }) => {
  log('hook_PreToolUse', { tool_name: input.tool_name, tool_use_id: toolUseId, tool_input: input.tool_input });
  if (input.tool_name !== 'mcp__human__ask_human') return {};
  if (mode === 'start' || mode === 'sigterm') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer', permissionDecisionReason: 'waiting for human' } };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...input.tool_input, answer: answerArg ?? 'blue' },
    },
  };
};

const baseOptions = {
  model: 'haiku',
  cwd: here,
  env,
  maxTurns: 6,
  mcpServers: {
    human: process.env.PROTO_SERVER === 'stdio'
      ? { type: 'stdio', command: process.execPath, args: [path.join(here, 'mcp-stdio.mjs')], env: { PROTO_STDIO_LOG: outFile } }
      : humanServer,
  },
  allowedTools: ['mcp__human__ask_human', 'Bash'],
  disallowedTools: ["AskUserQuestion"],
  strictMcpConfig: true,
  hooks: { PreToolUse: [{ matcher: 'mcp__human__ask_human', hooks: [preToolUse] }] },
};

async function* emptyPrompt() {}
let finishPrompt;
const promptDone = new Promise((r) => { finishPrompt = r; });
async function* openPrompt() { await promptDone; }

let prompt;
const options = { ...baseOptions };
switch (mode) {
  case 'start':
    prompt = 'Use the ask_human tool to ask me which color I prefer (options: red, blue). Then answer with exactly one word: the color I chose.';
    break;
  case 'resume':
  case 'resume-interrupted':
    prompt = process.env.PROTO_PROMPT_MODE === 'string' ? '' : process.env.PROTO_PROMPT_MODE === 'open' ? openPrompt() : emptyPrompt();
    options.resume = sessionArg;
    break;
  case 'resume-prompt':
    prompt = 'Continue.';
    options.resume = sessionArg;
    break;
  case 'tools-check':
    prompt = 'Reply with OK';
    options.canUseTool = async () => ({ behavior: 'deny', message: 'n/a' });
    if (process.env.PROTO_NO_DISALLOW) delete options.disallowedTools;
    break;
  case 'noq':
    prompt = 'You must ask me a clarifying question using the AskUserQuestion tool: which color do I prefer? If the tool is not available, reply exactly: NO_ASKUSERQUESTION_TOOL';
    break;
  case 'sigterm':
    prompt = 'Run the Bash command `sleep 20 && echo done` and then reply with exactly: DONE';
    break;
  default:
    throw new Error(`unknown mode ${mode}`);
}

log('run', { mode, sessionArg, answerArg, outFile, sdk: JSON.parse(fs.readFileSync(path.join(here, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'))).version });

const q = query({ prompt, options });
let sessionId;
let killed = false;
try {
  for await (const msg of q) {
    sessionId ??= msg.session_id;
    const brief = { type: msg.type, subtype: msg.subtype, session_id: msg.session_id };
    if (msg.type === 'system' && msg.subtype === 'init') {
      brief.tools = msg.tools;
      brief.mcp_servers = msg.mcp_servers;
      brief.model = msg.model;
      brief.permissionMode = msg.permissionMode;
      brief.apiKeySource = msg.apiKeySource;
    }
    if (msg.type === 'assistant' || msg.type === 'user') {
      brief.content = msg.message.content;
      brief.stop_reason = msg.message.stop_reason;
      brief.resume_reason = msg.resume_reason;
    }
    if (msg.type === 'result') {
      brief.stop_reason = msg.stop_reason;
      brief.terminal_reason = msg.terminal_reason;
      brief.deferred_tool_use = msg.deferred_tool_use;
      brief.is_error = msg.is_error;
      brief.result = msg.result;
      brief.num_turns = msg.num_turns;
      brief.resume_reason = msg.resume_reason;
      brief.permission_denials = msg.permission_denials;
    }
    log('msg', brief);
    if (mode === 'tools-check' && msg.type === 'system' && msg.subtype === 'init') { q.close(); break; }
    if (msg.type === 'result' && msg.stop_reason !== 'tool_deferred_unavailable') finishPrompt?.();
    if (mode === 'sigterm' && !killed && msg.type === 'assistant' && msg.message.content.some((b) => b.type === 'tool_use')) {
      const pids = execSync(`pgrep -P ${process.pid}`).toString().trim().split('\n').filter(Boolean);
      log('sigterm', { pids });
      for (const pid of pids) process.kill(Number(pid), 'SIGTERM');
      killed = true;
    }
  }
} catch (e) {
  log('error', { message: String(e?.message ?? e) });
}
log('done', { sessionId });
out.end();
