import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// How much of the last message of an Agent a dead end keeps: enough to tell why the Agent stopped.
export const LAST_MESSAGE_MAX_CHARS = 1500;

const textOf = (message: SDKMessage): string | undefined => {
  if (message.type === "assistant") {
    const text = message.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    return text || undefined;
  }
  if (message.type === "result" && message.subtype === "success") return message.result.trim() || undefined;
  return undefined;
};

// The last text an Agent said in `messages` (oldest first): an assistant message with text blocks or
// the text of a successful result; tool calls, thinking and stream deltas are skipped.
export const findLastAssistantText = (messages: readonly SDKMessage[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = textOf(messages[i] as SDKMessage);
    if (text !== undefined) return text;
  }
  return undefined;
};

// Keeps the tail of a long message: the end of the last word of an Agent explains where it stopped.
export const truncateMessage = (text: string, max = LAST_MESSAGE_MAX_CHARS): string =>
  text.length <= max ? text : `...${text.slice(text.length - max + 3)}`;

// A Markdown quote block of the text, line by line.
export const quoteMarkdown = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
