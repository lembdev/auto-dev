import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// The feed of one Agent as the panel renders it, built from `SDKMessage`s of the history and the
// live stream alike. Items are flat and ordered; `parent` nests a subagent's items under the
// tool call that started it.
export type FeedItemBase = { id: string; parent: string | null };

export type TextItem = FeedItemBase & { kind: "text"; text: string; streaming: boolean };
export type ThinkingItem = FeedItemBase & { kind: "thinking"; text: string; streaming: boolean };
export type ToolItem = FeedItemBase & {
  kind: "tool";
  name: string;
  input: unknown;
  // Input JSON as it streams in; parsed into `input` once the block stops.
  partialJson: string;
  result: string | null;
  isError: boolean;
  streaming: boolean;
  // Set once the tool call turned out to be a subagent (`task_started` names it).
  subagent: { type: string | null; description: string } | null;
};
export type UserItem = FeedItemBase & { kind: "user"; text: string };
export type SystemItem = FeedItemBase & { kind: "system"; text: string; level: "info" | "warn" };

export type FeedItem = TextItem | ThinkingItem | ToolItem | UserItem | SystemItem;

type Pending = { streamKey: string; stopped: boolean; messageId: string };

export type FeedState = {
  items: FeedItem[];
  // Message uuids already applied: the history and the live tail may overlap by a message or two.
  seen: Set<string>;
  // Streaming bookkeeping per item id: which API message and block the item is still receiving.
  pending: Map<string, Pending>;
  // The API message currently streaming per scope (root or a subagent's tool call).
  streams: Map<string, string>;
};

export const emptyFeed = (): FeedState => ({ items: [], seen: new Set(), pending: new Map(), streams: new Map() });

type Block = { type: string } & Record<string, unknown>;

const scopeOf = (parent: string | null): string => parent ?? "root";

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? content.filter((block): block is Block => typeof block === "object" && block !== null && typeof block.type === "string") : []);

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
};

const formatTokens = (tokens: number): string => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens));

const errorsOf = (message: SDKMessage): string => {
  if (message.type !== "result" || !("errors" in message)) return "";
  return Array.isArray(message.errors) ? message.errors.join("; ") : "";
};

// Applies one message and returns the next state; the previous state is left as it was.
export function applyMessage(previous: FeedState, message: SDKMessage): FeedState {
  const uuid = "uuid" in message && typeof message.uuid === "string" ? message.uuid : undefined;
  if (uuid !== undefined && previous.seen.has(uuid)) return previous;
  const state: FeedState = {
    items: [...previous.items],
    seen: uuid === undefined ? previous.seen : new Set(previous.seen).add(uuid),
    pending: new Map(previous.pending),
    streams: new Map(previous.streams),
  };
  switch (message.type) {
    case "assistant":
      applyAssistant(state, message);
      return state;
    case "user":
      applyUser(state, message);
      return state;
    case "stream_event":
      applyStreamEvent(state, message);
      return state;
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      const parts = [info.status, info.rateLimitType, info.utilization !== undefined ? `${Math.round(info.utilization * 100)} %` : undefined].filter(Boolean);
      pushSystem(state, uuid ?? `rate:${state.items.length}`, null, `лимит подписки: ${parts.join(" · ")}`, info.status === "rejected" ? "warn" : "info");
      return state;
    }
    case "result": {
      if (message.subtype === "success") {
        const deferred = message.stop_reason === "tool_deferred";
        pushSystem(state, uuid ?? `result:${state.items.length}`, null, deferred ? "Ход завершён: Запрос к человеку, Агент ждёт Ответа" : `Ход завершён (${message.stop_reason ?? "end_turn"})`, message.is_error ? "warn" : "info");
      } else {
        pushSystem(state, uuid ?? `result:${state.items.length}`, null, `Ход завершился ошибкой (${message.subtype}): ${errorsOf(message)}`, "warn");
      }
      return state;
    }
    case "system":
      applySystem(state, message, uuid);
      return state;
    default:
      return previous;
  }
}

export function applyMessages(state: FeedState, messages: SDKMessage[]): FeedState {
  return messages.reduce(applyMessage, state);
}

export const childrenOf = (items: FeedItem[], parent: string): FeedItem[] => items.filter((item) => item.parent === parent);

export const topLevelOf = (items: FeedItem[]): FeedItem[] => items.filter((item) => item.parent === null);

// Internals

function pushSystem(state: FeedState, id: string, parent: string | null, text: string, level: SystemItem["level"]): void {
  state.items.push({ kind: "system", id, parent, text, level });
}

const findIndex = (state: FeedState, id: string): number => {
  for (let i = state.items.length - 1; i >= 0; i -= 1) if (state.items[i]?.id === id) return i;
  return -1;
};

const replace = (state: FeedState, index: number, item: FeedItem): void => {
  state.items[index] = item;
};

function applyAssistant(state: FeedState, message: Extract<SDKMessage, { type: "assistant" }>): void {
  const parent = message.parent_tool_use_id;
  const api = message.message;
  const blocks = blocksOf(api.content);
  // The streamed version of a finished block goes; the complete block takes its place.
  const stoppedPending = [...state.pending.entries()].filter(([, pending]) => pending.messageId === api.id && pending.stopped);
  for (const [id] of stoppedPending) {
    const index = findIndex(state, id);
    if (index >= 0) state.items.splice(index, 1);
    state.pending.delete(id);
  }
  blocks.forEach((block, i) => {
    const id = `${message.uuid}:${i}`;
    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text.trim() === "") return;
      state.items.push({ kind: "text", id, parent, text, streaming: false });
    } else if (block.type === "thinking") {
      const text = typeof block.thinking === "string" ? block.thinking : "";
      state.items.push({ kind: "thinking", id, parent, text, streaming: false });
    } else if (block.type === "tool_use" && typeof block.id === "string") {
      const item: ToolItem = {
        kind: "tool",
        id: block.id,
        parent,
        name: typeof block.name === "string" ? block.name : "tool",
        input: block.input,
        partialJson: "",
        result: null,
        isError: false,
        streaming: false,
        subagent: null,
      };
      const index = findIndex(state, block.id);
      if (index >= 0) {
        const existing = state.items[index] as ToolItem;
        replace(state, index, { ...item, result: existing.result, isError: existing.isError, subagent: existing.subagent });
        state.pending.delete(block.id);
      } else {
        state.items.push(item);
      }
    }
  });
}

function applyUser(state: FeedState, message: Extract<SDKMessage, { type: "user" }>): void {
  const parent = message.parent_tool_use_id;
  const content = message.message.content;
  const id = message.uuid ?? `user:${state.items.length}`;
  if (typeof content === "string") {
    if (content.trim() !== "") state.items.push({ kind: "user", id, parent, text: content });
    return;
  }
  const blocks = blocksOf(content);
  blocks.forEach((block, i) => {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const result = textOf(block.content);
      const isError = block.is_error === true;
      const index = findIndex(state, block.tool_use_id);
      if (index >= 0) {
        const tool = state.items[index] as ToolItem;
        replace(state, index, { ...tool, result, isError });
      } else {
        // The call itself is outside the history read; the result still tells what happened.
        state.items.push({ kind: "tool", id: block.tool_use_id, parent, name: "tool", input: null, partialJson: "", result, isError, streaming: false, subagent: null });
      }
    } else if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      state.items.push({ kind: "user", id: `${id}:${i}`, parent, text: block.text });
    }
  });
}

function applyStreamEvent(state: FeedState, message: Extract<SDKMessage, { type: "stream_event" }>): void {
  const parent = message.parent_tool_use_id;
  const scope = scopeOf(parent);
  const event = message.event as { type: string } & Record<string, unknown>;
  switch (event.type) {
    case "message_start": {
      const api = event.message as { id?: string } | undefined;
      if (api?.id) state.streams.set(scope, api.id);
      return;
    }
    case "content_block_start": {
      const messageId = state.streams.get(scope);
      if (messageId === undefined) return;
      const index = event.index as number;
      const block = event.content_block as Block | undefined;
      if (!block) return;
      const streamKey = `${messageId}:${index}`;
      if (block.type === "text") {
        state.items.push({ kind: "text", id: streamKey, parent, text: typeof block.text === "string" ? block.text : "", streaming: true });
        state.pending.set(streamKey, { streamKey, stopped: false, messageId });
      } else if (block.type === "thinking") {
        state.items.push({ kind: "thinking", id: streamKey, parent, text: typeof block.thinking === "string" ? block.thinking : "", streaming: true });
        state.pending.set(streamKey, { streamKey, stopped: false, messageId });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        state.items.push({ kind: "tool", id: block.id, parent, name: typeof block.name === "string" ? block.name : "tool", input: block.input ?? null, partialJson: "", result: null, isError: false, streaming: true, subagent: null });
        state.pending.set(block.id, { streamKey, stopped: false, messageId });
      }
      return;
    }
    case "content_block_delta": {
      const messageId = state.streams.get(scope);
      if (messageId === undefined) return;
      const streamKey = `${messageId}:${event.index as number}`;
      const entry = [...state.pending.entries()].find(([, pending]) => pending.streamKey === streamKey);
      if (!entry) return;
      const index = findIndex(state, entry[0]);
      if (index < 0) return;
      const item = state.items[index] as FeedItem;
      const delta = event.delta as Block | undefined;
      if (!delta) return;
      if (delta.type === "text_delta" && item.kind === "text") replace(state, index, { ...item, text: item.text + String(delta.text ?? "") });
      else if (delta.type === "thinking_delta" && item.kind === "thinking") replace(state, index, { ...item, text: item.text + String(delta.thinking ?? "") });
      else if (delta.type === "input_json_delta" && item.kind === "tool") replace(state, index, { ...item, partialJson: item.partialJson + String(delta.partial_json ?? "") });
      return;
    }
    case "content_block_stop": {
      const messageId = state.streams.get(scope);
      if (messageId === undefined) return;
      const streamKey = `${messageId}:${event.index as number}`;
      const entry = [...state.pending.entries()].find(([, pending]) => pending.streamKey === streamKey);
      if (!entry) return;
      state.pending.set(entry[0], { ...entry[1], stopped: true });
      const index = findIndex(state, entry[0]);
      const item = index >= 0 ? (state.items[index] as FeedItem) : undefined;
      if (item?.kind === "tool" && item.partialJson !== "") replace(state, index, { ...item, input: parseJson(item.partialJson) ?? item.input });
      return;
    }
    case "message_stop": {
      const messageId = state.streams.get(scope);
      state.streams.delete(scope);
      if (messageId === undefined) return;
      // Whatever still streams for this message is complete now, even without its final message.
      for (const [id, pending] of [...state.pending.entries()]) {
        if (pending.messageId !== messageId) continue;
        const index = findIndex(state, id);
        if (index >= 0) replace(state, index, { ...(state.items[index] as FeedItem), streaming: false } as FeedItem);
      }
      return;
    }
    default:
      return;
  }
}

function applySystem(state: FeedState, message: Extract<SDKMessage, { type: "system" }>, uuid: string | undefined): void {
  const id = uuid ?? `system:${state.items.length}`;
  switch (message.subtype) {
    case "init":
      pushSystem(state, id, null, `процесс запущен · ${message.model}`, "info");
      return;
    case "compact_boundary": {
      const meta = message.compact_metadata;
      const sizes = meta.post_tokens !== undefined ? `${formatTokens(meta.pre_tokens)} -> ${formatTokens(meta.post_tokens)} токенов` : `${formatTokens(meta.pre_tokens)} токенов`;
      pushSystem(state, id, null, `контекст сжат (${meta.trigger}): ${sizes}`, "info");
      return;
    }
    case "status":
      if (message.status === "compacting") pushSystem(state, id, null, "сжатие контекста…", "info");
      else if (message.compact_result === "failed") pushSystem(state, id, null, `сжатие контекста не удалось: ${message.compact_error ?? ""}`, "warn");
      return;
    case "api_retry":
      pushSystem(state, id, null, `повтор запроса к API: попытка ${message.attempt} из ${message.max_retries} через ${Math.round(message.retry_delay_ms / 1000)} с (${message.error}${message.error_status !== null ? `, ${message.error_status}` : ""})`, "warn");
      return;
    case "task_started": {
      const toolUseId = message.tool_use_id;
      const index = toolUseId !== undefined ? findIndex(state, toolUseId) : -1;
      if (index >= 0) {
        const tool = state.items[index] as ToolItem;
        replace(state, index, { ...tool, subagent: { type: message.subagent_type ?? null, description: message.description } });
      } else {
        pushSystem(state, id, null, `сабагент ${message.subagent_type ?? ""}: ${message.description}`, "info");
      }
      return;
    }
    case "task_notification":
      pushSystem(state, id, message.tool_use_id ?? null, `сабагент завершён (${message.status}): ${message.summary}`, message.status === "failed" ? "warn" : "info");
      return;
    default:
      return;
  }
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

// The one line of a tool call in the collapsed row: the argument a human recognises it by.
export function toolHead(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "pattern", "path", "url", "query", "question", "description", "prompt"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return firstLineOf(value, 120);
  }
  return firstLineOf(JSON.stringify(input), 120);
}

const firstLineOf = (text: string, limit: number): string => {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "")?.trim() ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

export const formatInput = (input: unknown): string => (input === null || input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input, null, 2));
