/**
 * Briefing context signals (ADR-0083): evidence-backed views made at query time.
 * They are never durable memory. Briefing work must not write `user_facts`;
 * identity writes belong to the ADR-0080 projection.
 */

import { z } from "zod";

import { parseBriefingReference, type BriefingReference } from "./briefing-references";

export interface BriefingContextSignalDef {
  readonly description: string;
}

/** Generic kinds. Domain meaning goes in `summary`, not in new members. */
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

export const MAX_BRIEFING_SIGNAL_SUMMARY_LENGTH = 280;

export const MAX_BRIEFING_SIGNAL_EVIDENCE = 16;

/** A valid `BriefingReference` token. */
export const briefingEvidenceRefSchema = z
  .string()
  .refine((value): value is BriefingReference => parseBriefingReference(value) !== null, {
    message: "Not a valid briefing reference token (expected `<kind>:<id>`).",
  });

/** `summary` is required because `kind` says only how the evidence matters. */
export const briefingContextSignalSchema = z
  .object({
    kind: briefingContextSignalKindSchema,
    summary: z.string().min(1).max(MAX_BRIEFING_SIGNAL_SUMMARY_LENGTH),
    evidence: z.array(briefingEvidenceRefSchema).min(1).max(MAX_BRIEFING_SIGNAL_EVIDENCE),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export type BriefingContextSignal = z.infer<typeof briefingContextSignalSchema>;
