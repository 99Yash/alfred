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
 * What happened to the write, apart from the approval `status`.
 * `unknown`: maybe delivered, never proven. It blocks repeats and never auto-retries.
 * `refused`: the provider was never called, so it is not an attempt.
 * `superseded`: a new user authorization replaced an `unknown` row. The unique index
 * allows one `unknown` row per `request_hash`. Only the MCP recovery path writes it.
 */
export const effectOutcomeSchema = z.enum([
  "planned",
  "awaiting_approval",
  "dispatching",
  "succeeded",
  "failed",
  "unknown",
  "superseded",
  "compensated",
  "refused",
]);

export const EFFECT_OUTCOMES = Object.freeze([...effectOutcomeSchema.options]);

export type EffectOutcome = z.infer<typeof effectOutcomeSchema>;

/**
 * Tool result for a write that may have landed but is not confirmed.
 * `retry: "blocked"`: the model must check the target, not repeat the call.
 * The dispatch gate reads this shape to set `outcome` to `unknown`.
 */
export const unknownEffectEnvelopeSchema = z.object({
  status: z.literal("unknown"),
  retry: z.literal("blocked"),
  message: z.string(),
});

export type UnknownEffectEnvelope = z.infer<typeof unknownEffectEnvelopeSchema>;

export function isUnknownEffectEnvelope(value: unknown): value is UnknownEffectEnvelope {
  return unknownEffectEnvelopeSchema.validate(value);
}
