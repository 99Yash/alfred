import { z } from "zod";

/**
 * Discriminated union of every event kind that flows through the durable
 * outbox -> Redis Pub/Sub -> SSE pipeline.
 *
 * Replicache pokes are intentionally absent. They have a separate, lower-
 * latency bus.
 */
export const agentProgressSchema = z.object({
  runId: z.string().min(1).max(120),
  step: z.string().min(1).max(120),
  message: z.string().max(2_000).optional(),
});

export const toolCallSchema = z.object({
  runId: z.string().min(1).max(120),
  toolName: z.string().min(1).max(120),
  status: z.enum(["started", "succeeded", "failed"]),
  detail: z.string().max(2_000).optional(),
});

export const approvalRequestedSchema = z.object({
  runId: z.string().min(1).max(120),
  approvalId: z.string().min(1).max(120),
  approvalKind: z.enum(["step", "action_staging"]),
  prompt: z.string().min(1).max(4_000),
});

export const agentRunSchema = z.object({
  runId: z.string().min(1).max(120),
  phase: z.enum([
    "started",
    "step_started",
    "step_completed",
    "interrupted",
    "resumed",
    "completed",
    "failed",
    "cancelled",
  ]),
  step: z.string().min(1).max(120).optional(),
  attempt: z.number().int().nonnegative().optional(),
  workflowSlug: z.string().min(1).max(120).optional(),
  wake: z.unknown().optional(),
  error: z.string().max(4_000).optional(),
});

export const memoryFactLearnedSchema = z.object({
  factId: z.string().min(1).max(120),
  key: z.string().min(1).max(200),
  preview: z.string().max(280),
  confidence: z.number().min(0).max(1),
});

/**
 * The Gmail inbox view has changed in a way that warrants a re-fetch.
 *
 *  - `reason: 'ingested'` — one or more new documents were inserted by the
 *    ingest worker (`gmail.poll_recent` / `poll_history` / `ingest_recent`).
 *  - `reason: 'triaged'` — the triage workflow classified a thread and the
 *    row's category chip may have changed.
 *
 * Publishers should coalesce: emit at most once per ingestion job or per
 * triage run rather than per document. The client invalidates the rail's
 * `["me","inbox"]` React Query on receipt; the payload is deliberately
 * minimal so we don't try to do partial client-side merges.
 */
export const inboxUpdatedSchema = z.object({
  reason: z.enum(["ingested", "triaged"]),
  /** Best-effort count of affected docs for telemetry — not load-bearing. */
  count: z.number().int().nonnegative().max(10_000).optional(),
});

/**
 * Interactive-chat streaming events. These ride the same durable outbox →
 * Redis → SSE pipeline as the agent lifecycle events, scoped to a chat
 * thread + the agent run servicing the latest turn.
 *
 * `chat.delta` carries a *coalesced* text chunk, not a single token — the
 * worker buffers model output and flushes every ~200ms so we don't write one
 * outbox row per token. `seq` is monotonic per (runId, messageId) so the
 * client can order/dedupe deltas. The assistant message is also persisted via
 * Replicache on completion; streamed deltas are ephemeral UI reconciled
 * against that durable copy.
 */
export const chatDeltaSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  seq: z.number().int().nonnegative(),
  text: z.string().max(16_000),
});

/**
 * A tool call inside a chat turn, surfaced as a live card. `started` fires
 * when the agent emits the call (with a preview of its input), `succeeded` /
 * `failed` when the dispatcher returns. Write actions that need approval do
 * NOT resolve here — they interrupt the run and emit `approval.requested`.
 */
export const chatToolSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  toolCallId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(120),
  status: z.enum(["started", "succeeded", "failed"]),
  /** Trimmed JSON preview of the tool input — never the full args blob. */
  argsPreview: z.string().max(2_000).optional(),
  /** Trimmed preview of the tool result for the card's done state. */
  resultPreview: z.string().max(2_000).optional(),
});

/**
 * Lifecycle of the assistant message backing a chat turn. `started` lets the
 * client mount the in-flight bubble keyed by `messageId`; `completed` signals
 * the durable message has been persisted (Replicache poke incoming) so the
 * client can reconcile the streamed bubble against the synced copy.
 */
export const chatMessageSchema = z.object({
  runId: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  phase: z.enum(["started", "completed"]),
});

export const eventPayloadSchemas = {
  "agent.progress": agentProgressSchema,
  "agent.run": agentRunSchema,
  "tool.call": toolCallSchema,
  "approval.requested": approvalRequestedSchema,
  "memory.fact_learned": memoryFactLearnedSchema,
  "inbox.updated": inboxUpdatedSchema,
  "chat.delta": chatDeltaSchema,
  "chat.tool": chatToolSchema,
  "chat.message": chatMessageSchema,
} as const satisfies Record<string, z.ZodType>;

export type EventKind = keyof typeof eventPayloadSchemas;
export type EventPayload<K extends EventKind> = z.infer<(typeof eventPayloadSchemas)[K]>;

export const EVENT_KINDS = Object.freeze(Object.keys(eventPayloadSchemas) as EventKind[]);

export const eventFrameSchema = z.object({
  id: z.number().int().positive(),
  kind: z.custom<EventKind>((value) => typeof value === "string" && isKnownEventKind(value), {
    message: "must be a known event kind",
  }),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type EventFrame = z.infer<typeof eventFrameSchema>;

export function isKnownEventKind(value: string): value is EventKind {
  return Object.prototype.hasOwnProperty.call(eventPayloadSchemas, value);
}
