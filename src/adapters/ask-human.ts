// Names shared by the Driver (hook, MCP config) and the stdio server of the `ask_human` tool.
export const ASK_HUMAN_SERVER = "human";
export const ASK_HUMAN_TOOL = "ask_human";
// Claude Code names MCP tools `mcp__<server>__<tool>`; hooks and allow lists match on this.
export const ASK_HUMAN_TOOL_NAME = `mcp__${ASK_HUMAN_SERVER}__${ASK_HUMAN_TOOL}`;

export const ASK_HUMAN_DESCRIPTION =
  "Ask the human operator a question and wait for the answer. The question is published to the task issue; " +
  "the turn ends until a human answers. Call it alone, never together with other tool calls.";

// Input of the tool as the model fills it, plus the fields the Orchestrator adds on resume.
export type AskHumanInput = {
  question: string;
  options?: string[] | undefined;
  answer?: string | undefined;
  source?: string | undefined;
};

export const NO_ANSWER_TEXT = "No answer from the human yet.";

// Text the Agent receives as the tool result once the Answer is delivered.
export function formatAskHumanResult(input: AskHumanInput): string {
  if (input.answer === undefined || input.answer === "") return NO_ANSWER_TEXT;
  return input.source ? `${input.answer}\n\n(answered by ${input.source})` : input.answer;
}
