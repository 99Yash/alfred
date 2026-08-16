import { z } from "zod";

export const actionStagingStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
  "failed",
]);
export const ACTION_STAGING_STATUSES = Object.freeze([...actionStagingStatusSchema.options]);
export type ActionStagingStatus = z.infer<typeof actionStagingStatusSchema>;

/**
 * The effect dimension of a staging row (#559a). Distinct from `status`, which
 * is the approval-gate machine: an `executed` row may be `succeeded`, `failed`,
 * or `unknown`, and a gated row is `awaiting_approval` from the moment it is
 * staged. `unknown` is the sticky case — a possibly-delivered write whose
 * outcome was never provable; it holds the ambiguity barrier and never
 * auto-retries. `compensated` marks an effect the system reversed after it
 * `succeeded`.
 */
export const effectOutcomeSchema = z.enum([
  "planned",
  "awaiting_approval",
  "dispatching",
  "succeeded",
  "failed",
  "unknown",
  "compensated",
]);
export const EFFECT_OUTCOMES = Object.freeze([...effectOutcomeSchema.options]);
export type EffectOutcome = z.infer<typeof effectOutcomeSchema>;

/**
 * The model-safe "possibly delivered, outcome unprovable" envelope (#559a). A
 * tool (today only the MCP broker, whose ambiguous attempt is projected here)
 * or the dispatch gate's ambiguity barrier returns it when a write may have
 * landed but was never confirmed. `retry: "blocked"` is the load-bearing field:
 * the model must NOT self-correct by repeating the call — it can only check the
 * target's state. The dispatch gate recognises this shape to record the staging
 * row's `outcome` as `unknown`; keeping the shape here means the producer and
 * the recognizer cannot drift.
 */
export const unknownEffectEnvelopeSchema = z.object({
  status: z.literal("unknown"),
  retry: z.literal("blocked"),
  message: z.string(),
});
export type UnknownEffectEnvelope = z.infer<typeof unknownEffectEnvelopeSchema>;

export function isUnknownEffectEnvelope(value: unknown): value is UnknownEffectEnvelope {
  return unknownEffectEnvelopeSchema.safeParse(value).success;
}
