import { z } from "zod";

/**
 * A model-emitted confidence in the conceptual range [0, 1].
 *
 * Deliberately a bare `z.number()` with NO `.min(0).max(1)`: the cheap-model
 * getter (`getCheapModel`) degrades cross-provider to Anthropic Haiku when
 * Gemini overloads, and Anthropic's structured-output JSON schema rejects
 * `minimum`/`maximum` on number types ("For 'number' type, properties maximum,
 * minimum are not supported"). A bare number emits `{"type":"number"}` in both
 * input and output JSON-Schema modes, so it round-trips through either provider.
 *
 * The [0, 1] range is a soft expectation, not a hard gate — the model
 * effectively always respects it, and an occasional out-of-range value is
 * harmless to the soft-confirm thresholds it feeds. Where a consumer keys a
 * documented threshold off it, clamp at that boundary (see triage `classify`).
 *
 * One source of truth so every cheap-model output schema (triage classify +
 * deepen, memory extraction, cold-start extract, skill distill) stays
 * Anthropic-compatible.
 */
export const confidenceSchema = z.number();
