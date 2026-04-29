import { z } from "zod";

/**
 * Discriminated union of every event kind that flows through the durable
 * outbox -> Redis Pub/Sub -> SSE pipeline.
 *
 * To add a new kind:
 *   1. Define a zod schema for its payload below.
 *   2. Add it to `eventPayloadSchemas`.
 *   3. The publish helper picks up the new kind automatically.
 *
 * Replicache pokes are intentionally absent — they have a separate, lower-
 * latency bus (events/replicache-events.ts).
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
  prompt: z.string().min(1).max(4_000),
});

export const eventPayloadSchemas = {
  "agent.progress": agentProgressSchema,
  "tool.call": toolCallSchema,
  "approval.requested": approvalRequestedSchema,
} as const satisfies Record<string, z.ZodType>;

export type EventKind = keyof typeof eventPayloadSchemas;
export type EventPayload<K extends EventKind> = z.infer<(typeof eventPayloadSchemas)[K]>;

/** SSE frame body — what the browser receives in `event.data`. */
export interface EventFrame {
  /** Outbox row id; doubles as the SSE Last-Event-ID. */
  id: number;
  kind: EventKind;
  payload: unknown;
  /** ISO-8601 timestamp from the outbox row. */
  createdAt: string;
}

export function isKnownEventKind(value: string): value is EventKind {
  return Object.prototype.hasOwnProperty.call(eventPayloadSchemas, value);
}
