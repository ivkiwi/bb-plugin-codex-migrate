import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SourceThread } from "./source.js";

const itemSchema = z.record(z.string(), z.unknown());
const turnSchema = z.object({
  id: z.string(),
  startedAt: z.number().nullable().optional(),
  completedAt: z.number().nullable().optional(),
  status: z.string().optional(),
  items: z.array(itemSchema).optional(),
}).passthrough();
const threadSchema = z.object({
  id: z.string(),
  createdAt: z.number().optional(),
  turns: z.array(turnSchema).optional(),
}).passthrough();

export interface ImportEvent {
  id: string;
  sequence: number;
  scopeKind: "thread" | "turn";
  turnId: string | null;
  providerThreadId: string | null;
  type: string;
  itemId: string | null;
  itemKind: string | null;
  data: string;
  createdAt: number;
}

export interface History {
  events: ImportEvent[];
  userMessages: number;
  assistantMessages: number;
  images: number;
  /** Latest real Codex turn time; null when every turn time had to be synthesized. */
  lastActivityAt: number | null;
}

export function newId(prefix: string): string {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  const random = randomBytes(16);
  let suffix = "";
  for (let index = 0; index < 10; index++) suffix += alphabet[random[index]! % alphabet.length];
  return `${prefix}_${suffix}`;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function status(value: unknown): string {
  return ["pending", "completed", "failed", "interrupted"].includes(value as string)
    ? value as string
    : "completed";
}

function normalizeUserContent(value: unknown): { parts: Record<string, unknown>[]; images: number } {
  const parts: Record<string, unknown>[] = [];
  let images = 0;
  for (const raw of array(value)) {
    const part = object(raw);
    const type = string(part.type);
    if (type === "text") parts.push({ type: "text", text: string(part.text), mentions: [] });
    else if ((type === "localImage" || type === "localFile") && typeof part.path === "string") {
      parts.push({ type, path: part.path });
      if (type === "localImage") images++;
    } else if (type === "image" && typeof part.url === "string") {
      parts.push({ type: "image", url: part.url });
      images++;
    }
  }
  return { parts, images };
}

function normalizeItem(item: Record<string, unknown>): Record<string, unknown> {
  const kind = string(item.type);
  const id = string(item.id, newId("legacy_item"));
  if (kind === "agentMessage") return { type: kind, id, text: string(item.text) };
  if (kind === "reasoning") return { type: kind, id, summary: array(item.summary), content: [] };
  if (kind === "plan") return { type: kind, id, text: string(item.text) };
  if (kind === "contextCompaction") return { type: kind, id };
  if (kind === "imageView") return { type: kind, id, path: string(item.path) };
  if (kind === "webSearch") {
    const action = object(item.action);
    const queries = array(action.queries).filter((query) => typeof query === "string");
    if (queries.length === 0) queries.push(string(action.query, string(item.query, "Web search")));
    return { type: kind, id, queries, resultText: item.results == null ? null : JSON.stringify(item.results) };
  }
  if (kind === "mcpToolCall") return {
    type: "toolCall", id, server: string(item.server, "mcp"), tool: string(item.tool, "unknown"),
    arguments: object(item.arguments), status: status(item.status), result: item.result ?? null,
    ...(item.error == null ? {} : { error: string(item.error, JSON.stringify(item.error)) }),
    durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
  };
  if (kind === "functionCallOutput") return {
    type: "toolCall", id, server: string(item.namespace, "codex"),
    tool: string(item.name, "functionCallOutput"), status: "completed", result: item.output ?? null,
  };
  if (kind === "commandExecution") return {
    type: kind, id, command: string(item.command), cwd: string(item.cwd),
    status: status(item.status), approvalStatus: null, aggregatedOutput: string(item.aggregatedOutput),
    exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
    durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
  };
  if (kind === "fileChange") return {
    type: kind, id,
    changes: array(item.changes).map((raw) => {
      const change = object(raw);
      const rawKind = change.kind;
      const changeKind = typeof rawKind === "string" ? rawKind : string(object(rawKind).type, "update");
      return {
        path: string(change.path),
        kind: ["add", "delete", "update"].includes(changeKind) ? changeKind : "update",
        ...(typeof change.movePath === "string" ? { movePath: change.movePath } : {}),
        ...(typeof change.diff === "string" ? { diff: change.diff } : {}),
      };
    }),
    status: status(item.status), approvalStatus: null,
  };
  return { type: "toolCall", id, server: "codex-import", tool: kind || "unknown", status: "completed", result: item };
}

export function convertHistory(raw: unknown, meta: SourceThread): History {
  const source = threadSchema.parse(raw);
  if (source.id !== meta.id) throw new Error(`Codex thread identity mismatch for ${meta.id}`);
  const events: ImportEvent[] = [];
  let sequence = 0;
  let users = 0;
  let assistants = 0;
  let images = 0;
  let lastActivityAt: number | null = null;
  const add = (type: string, data: Record<string, unknown>, createdAt: number, turnId: string | null = null, item: Record<string, unknown> | null = null) => {
    events.push({
      id: newId("evt"), sequence: ++sequence, scopeKind: turnId ? "turn" : "thread", turnId,
      providerThreadId: type === "client/turn/requested" || type === "thread/started" ? null : meta.id,
      type, itemId: item ? string(item.id) : null, itemKind: item ? string(item.type) : null,
      data: JSON.stringify(data), createdAt: Math.floor(createdAt),
    });
  };
  const created = meta.createdAtMs || Math.floor((source.createdAt ?? 0) * 1000);
  add("thread/started", {}, created);
  add("thread/identity", { providerThreadId: meta.id }, created + 1);
  let previousEnd = created + 2;
  for (const turn of source.turns ?? []) {
    const turnId = turn.id;
    let start = turn.startedAt ? Math.floor(turn.startedAt * 1000) : previousEnd + 1;
    let end = turn.completedAt ? Math.floor(turn.completedAt * 1000) : start + Math.max(1000, (turn.items ?? []).length * 2);
    start = Math.max(start, previousEnd + 1);
    end = Math.max(end, start + (turn.items ?? []).length + 3);
    const items = turn.items ?? [];
    const firstUser = items[0]?.type === "userMessage";
    if (!firstUser) add("turn/started", { providerThreadId: meta.id }, start, turnId);
    let userInTurn = 0;
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const at = start + 1 + index * Math.max(1, Math.floor((end - start - 2) / Math.max(1, items.length)));
      if (item.type === "userMessage") {
        users++;
        userInTurn++;
        const requestId = newId("creq");
        const content = normalizeUserContent(item.content);
        images += content.images;
        add("client/turn/requested", {
          direction: "outbound", source: "tell", initiator: "user",
          request: { method: "turn/start", params: {} }, requestId, senderThreadId: null,
          input: content.parts,
          target: userInTurn === 1 ? { kind: "new-turn" } : { kind: "steer", expectedTurnId: turnId },
          execution: {
            model: meta.model ?? "gpt-6-astra", permissionMode: "auto",
            reasoningLevel: meta.reasoningEffort ?? "medium", serviceTier: "default",
            source: "client/turn/requested",
          },
        }, at);
        if (firstUser && index === 0) add("turn/started", { providerThreadId: meta.id }, at + 1, turnId);
        add("turn/input/accepted", { providerThreadId: meta.id, clientRequestId: requestId }, at + 2, turnId);
      } else {
        const normalized = normalizeItem(item);
        if (normalized.type === "agentMessage") assistants++;
        add("item/completed", { providerThreadId: meta.id, item: normalized }, at, turnId, normalized);
      }
    }
    add("turn/completed", { providerThreadId: meta.id, status: status(turn.status) }, end, turnId);
    const realTime = turn.completedAt ?? turn.startedAt;
    if (realTime) lastActivityAt = Math.max(lastActivityAt ?? 0, Math.floor(realTime * 1000));
    previousEnd = end;
  }
  return { events, userMessages: users, assistantMessages: assistants, images, lastActivityAt };
}
