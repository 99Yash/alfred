import { z } from "zod";

/**
 * Clamp a (possibly out-of-range) model-emitted number into [0, 1].
 *
 * The single source of truth for confidence clamping: every consumer that keys
 * a real threshold off a model confidence (triage soft-confirm, the
 * `proposeFact`/`supersedeFact` [0, 1] gate) runs the value through this at its
 * boundary rather than relying on the schema to enforce the range — see
 * {@link confidenceSchema} for why the schema can't.
 */
export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * A model-emitted confidence in the conceptual range [0, 1].
 *
 * Deliberately a bare `z.number()` with NO `.min(0).max(1)`: the cheap-model
 * structured-output path can't express a numeric range in its JSON schema
 * ("For 'number' type, properties maximum, minimum are not supported"), so the
 * range has to be a soft expectation rather than a schema gate. A bare number
 * emits `{"type":"number"}`, which round-trips cleanly through structured
 * output. (Historically this also guarded a cross-provider Anthropic Haiku
 * fallback; `getCheapModel` now degrades same-provider to Gemini Flash, but the
 * bare-number choice stands — it keeps the schema portable and the constraint
 * one-sided is still enforced where it matters.)
 *
 * The [0, 1] range is a soft expectation, not a hard gate — the model
 * effectively always respects it, and an occasional out-of-range value is
 * harmless to the soft-confirm thresholds it feeds. Where a consumer keys a
 * documented threshold off it, clamp at that boundary with {@link clamp01}
 * (triage `classify`, `proposeFact`/`supersedeFact`).
 *
 * One source of truth so every cheap-model output schema (triage classify +
 * deepen, memory extraction, cold-start extract, skill distill) stays
 * structured-output-compatible.
 */
export const confidenceSchema = z.number();
