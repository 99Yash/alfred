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
  // Canonical pending-approval browser event for both legacy step HIL
  // and m13 action staging. The durable `/approvals` queue rides
  // Replicache; do not emit a separate `staging_pending` event for the
  // same action_stagings row.
  approvalKind: z.enum(["step", "action_staging"]),
  prompt: z.string().min(1).max(4_000),
});

/**
 * Lifecycle phases of a durable agent run. `started` fires once per run;
 * `step_started` / `step_completed` fire per attempt; `interrupted` fires
 * when a step parks the run on a wake condition; `completed` / `failed`
 * / `cancelled` are terminal. `cancelled` is fired by `cancelRun` (the
 * approvals "Reject and end run" path) — distinct from `failed` so the
 * UI can show "you cancelled" instead of "we hit an error".
 */
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

/**
 * Soft-notification event fired when alfred auto-confirms a fact (ADR-0019).
 * The UI renders a non-modal toast with the key + a brief value preview;
 * the user can click `undo` to flip to `rejected` (which signs the value
 * into `rejected_inferences` so re-extraction won't re-propose).
 *
 * Only auto-confirmations emit this — explicit user confirms via the
 * Memory page already have their own UX.
 */
export const memoryFactLearnedSchema = z.object({
  factId: z.string().min(1).max(120),
  key: z.string().min(1).max(200),
  /** Short stringified preview — full value rides Replicache. */
  preview: z.string().max(280),
  confidence: z.number().min(0).max(1),
});

export const eventPayloadSchemas = {
  "agent.progress": agentProgressSchema,
  "agent.run": agentRunSchema,
  "tool.call": toolCallSchema,
  "approval.requested": approvalRequestedSchema,
  "memory.fact_learned": memoryFactLearnedSchema,
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
