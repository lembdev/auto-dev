import { Hono } from "hono";
import type { HumanRequestId, IssueNumber, PendingMessageId } from "../../ids.js";
import type { PendingMessage } from "../../index/dialogue.js";
import type { RuntimeIndex } from "../../index/runtime-index.js";
import type { Logger } from "../../log.js";
import { GITHUB_CLIENT_ID, type AnswerFrame, type DialogueFrame } from "../../orchestrator/dialogue.js";
import type { Orchestrator } from "../../orchestrator/orchestrator.js";
import type { PlannerFrame } from "../../orchestrator/planner.js";
import type { DialogueMessageView, DialogueResponse, RemoveDialogueResponse } from "../api-types.js";

export type DialogueRoutesDeps = {
  index: RuntimeIndex;
  log: Logger;
  orchestrator: Pick<Orchestrator, "dialogue">;
};

export const dialogueMessageView = (message: PendingMessage): DialogueMessageView => ({
  id: message.id,
  issueNumber: message.issueNumber,
  agentId: message.agentId,
  source: message.clientId === GITHUB_CLIENT_ID ? "github" : "ui",
  clientId: message.clientId,
  seq: message.seq,
  text: message.text,
  createdAt: message.createdAt,
});

const positiveInt = (raw: unknown): number | undefined => {
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

// A frame of the Dialogue read off the socket. `undefined` means the frame is not one of ours;
// a frame with a sender but a broken body gets a refusal the sender can act on.
export type ParsedDialogueFrame =
  | { ok: true; frame: DialogueFrame | AnswerFrame | PlannerFrame }
  | { ok: false; clientId: string; seq: number; reason: string };

export const parseDialogueFrame = (raw: unknown): ParsedDialogueFrame | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const message = raw as Record<string, unknown>;
  if (message.type !== "dialogue" && message.type !== "answer") return undefined;
  const seq = positiveInt(message.seq);
  if (typeof message.clientId !== "string" || message.clientId === "" || message.clientId === GITHUB_CLIENT_ID || seq === undefined) return undefined;
  const clientId = message.clientId;
  if (typeof message.text !== "string") return { ok: false, clientId, seq, reason: "`text` must be a string" };
  if (message.type === "dialogue" && message.to !== undefined) {
    if (message.to !== "planner") return { ok: false, clientId, seq, reason: "`to` must be \"planner\" or absent" };
    return { ok: true, frame: { type: "planner", clientId, seq, text: message.text } };
  }
  if (message.type === "dialogue") {
    const issueNumber = positiveInt(message.issueNumber);
    if (issueNumber === undefined) return { ok: false, clientId, seq, reason: "`issueNumber` must be a positive integer" };
    return { ok: true, frame: { type: "dialogue", clientId, seq, issueNumber: issueNumber as IssueNumber, text: message.text } };
  }
  const requestId = positiveInt(message.requestId);
  if (requestId === undefined) return { ok: false, clientId, seq, reason: "`requestId` must be a positive integer" };
  return { ok: true, frame: { type: "answer", clientId, seq, requestId: requestId as HumanRequestId, text: message.text } };
};

// The queue of the Dialogue of one Task, mounted under `/api/tasks`: what has not reached the Session
// yet, and taking a line back. Lines themselves travel over `/ws` with an ACK each.
export function dialogueRoutes(deps: DialogueRoutesDeps): Hono {
  const routes = new Hono();

  routes.get("/:issue/dialogue", (c) => {
    const issueNumber = positiveInt(c.req.param("issue")) as IssueNumber | undefined;
    const task = issueNumber === undefined ? undefined : deps.index.tasks.find(issueNumber);
    if (!task) return c.json({ error: "task not found" }, 404);
    const body: DialogueResponse = { messages: deps.orchestrator.dialogue.list(task.issueNumber).map(dialogueMessageView) };
    return c.json(body);
  });

  routes.delete("/:issue/dialogue/:id", (c) => {
    const issueNumber = positiveInt(c.req.param("issue")) as IssueNumber | undefined;
    const id = positiveInt(c.req.param("id")) as PendingMessageId | undefined;
    const task = issueNumber === undefined ? undefined : deps.index.tasks.find(issueNumber);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (id === undefined) return c.json({ error: "message not found" }, 404);
    const outcome = deps.orchestrator.dialogue.remove(task.issueNumber, id);
    if (outcome === "not-found") return c.json({ error: "message not found" }, 404);
    if (outcome === "delivered") return c.json({ error: "the line already reached the Session" }, 409);
    deps.log.info({ issue: task.issueNumber, message: id }, "dialogue line removed from the UI");
    const body: RemoveDialogueResponse = { id };
    return c.json(body);
  });

  return routes;
}
