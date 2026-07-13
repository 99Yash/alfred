/**
 * Briefing context signals + the memory-write policy that keeps briefings
 * agent-safe (ADR-0083, #415, under the #218 user-model spine).
 *
 * A briefing is a render of the user's current context, not a summary of
 * inputs. Everything a writer says flows through three layers:
 *
 *   1. **Source evidence** — provenance-bearing gather items, each addressable
 *      by a `BriefingReference` and validated at its owning boundary.
 *   2. **Typed context signals** — a generic description of what is happening
 *      around the user. Every signal is evidence-backed and bounded.
 *   3. **Generated prose** — the warm paragraph the writer emits. It consumes
 *      Layer 2 and is ephemeral by construction.
 *
 * Context signals are query-time views, never durable memory. Identity and
 * organization writes remain the job of the ADR-0080 identity projection.
 * Briefing work must not promote document metadata, third-party attributes, or
 * contextual interpretations into `user_facts`.
 *
 * Pure module — no Node imports (consumed across the web boundary), mirroring
 * `briefing.ts` / `user-model.ts`.
 */

import { z } from "zod";

import { parseBriefingReference, type BriefingReference } from "./briefing-references";

export interface BriefingContextSignalDef {
  readonly description: string;
}

// ─────────────────────────────────────────────────────────────────────────
// The generic taxonomy (Layer 2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stable ways that evidence can matter to the user's current situation.
 * Domain meaning belongs in `summary`, not in one-off enum members.
 */
export const BRIEFING_CONTEXT_SIGNAL_KINDS = [
  "development",
  "open_loop",
  "pattern",
  "constraint",
] as const;
export const briefingContextSignalKindSchema = z.enum(BRIEFING_CONTEXT_SIGNAL_KINDS);
export type BriefingContextSignalKind = (typeof BRIEFING_CONTEXT_SIGNAL_KINDS)[number];

export const BRIEFING_CONTEXT_SIGNALS = {
  development: {
    description: "A material event or state change relevant to the user's current situation.",
  },
  open_loop: {
    description: "An unresolved commitment, question, or task still shaping the user's situation.",
  },
  pattern: {
    description: "An evidence-backed trend or recurring shape across the user's current context.",
  },
  constraint: {
    description:
      "A grounded limitation, dependency, or uncertainty affecting what the user can do or what Alfred can know.",
  },
} as const satisfies Record<BriefingContextSignalKind, BriefingContextSignalDef>;

export function isBriefingContextSignalKind(value: string): value is BriefingContextSignalKind {
  return Object.prototype.hasOwnProperty.call(BRIEFING_CONTEXT_SIGNALS, value);
}

// ────────────────────────────────────────────────────────────────────────
// Bounds + shape
// ──────────────────────────────────────────────────────────────────────────

/** A context summary is one crisp statement, not a paragraph of narrative. */
export const MAX_BRIEFING_SIGNAL_SUMMARY_LENGTH = 280;

/** A signal may not cite an unbounded fan of evidence. */
export const MAX_BRIEFING_SIGNAL_EVIDENCE = 16;

/** A validated Layer-1 provenance handle. */
export const briefingEvidenceRefSchema = z
  .string()
  .refine((value): value is BriefingReference => parseBriefingReference(value) !== null, {
    message: "Not a valid briefing reference token (expected `<kind>:<id>`).",
  });

/**
 * A query-time description of what is happening around the user. `summary` is
 * required because the generic kind only describes how the evidence matters;
 * it deliberately does not encode a domain-specific interpretation.
 */
export const briefingContextSignalSchema = z
  .object({
    kind: briefingContextSignalKindSchema,
    summary: z.string().min(1).max(MAX_BRIEFING_SIGNAL_SUMMARY_LENGTH),
    evidence: z.array(briefingEvidenceRefSchema).min(1).max(MAX_BRIEFING_SIGNAL_EVIDENCE),
    /** Optional [0,1] confidence for signals derived by a bounded projection. */
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type BriefingContextSignal = z.infer<typeof briefingContextSignalSchema>;
