/**
 * The tagged proposition the end-of-thread chat memory extractor emits (D4, D6).
 * Nothing writes these yet; the observation writer (#399) is not built.
 */

import { z } from "zod";
import { confidenceSchema } from "./model-output";

/** A primitive or a one-level object. Not `jsonValueSchema`: structured output fails on recursive schemas. */
export const propositionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
]);

export type PropositionValue = z.infer<typeof propositionValueSchema>;

/** How Alfred could confirm a proposition (D4). `integration_checkable` means a deterministic check on connected data. */
export const VERIFICATION_CLASSES = [
  "self_evident",
  "integration_checkable",
  "external_checkable",
  "user_only",
] as const;

export const verificationClassSchema = z.enum(VERIFICATION_CLASSES);

export type VerificationClass = (typeof VERIFICATION_CLASSES)[number];

/** Whether a proposition is likely to drift, e.g. a current title (D4). */
export const VOLATILITY_CLASSES = ["stable", "volatile"] as const;

export const volatilitySchema = z.enum(VOLATILITY_CLASSES);

export type Volatility = (typeof VOLATILITY_CLASSES)[number];

/**
 * Who said it: the user's assert, correct, confirm, or reject, or an Alfred inference.
 * The writer, not this module, maps it to an observation `(source, kind)` pair.
 */
export const PROPOSITION_ATTRIBUTIONS = [
  "user_assertion",
  "user_correction",
  "user_confirmation",
  "user_rejection",
  /** No enrichment source is registered yet (#987). */
  "alfred_enrichment",
] as const;

export const propositionAttributionSchema = z.enum(PROPOSITION_ATTRIBUTIONS);

export type PropositionAttribution = (typeof PROPOSITION_ATTRIBUTIONS)[number];

/** One proposition from a finished thread (D6). Flat, not a union: `oneOf` breaks structured output. */
export const chatPropositionSchema = z
  .object({
    subject: z.enum(["user", "entity"]),
    /** The entity as the model named it, e.g. an email or display name. */
    subjectRef: z.string().min(1).max(200).optional(),
    /** A best-guess snake_case key, e.g. `employer`. Canonicalized against the fact ontology later. */
    key: z.string().min(1).max(200),
    value: propositionValueSchema,
    verificationClass: verificationClassSchema,
    volatility: volatilitySchema,
    attribution: propositionAttributionSchema,
    confidence: confidenceSchema,
    /** Justification from the transcript, for audit. */
    rationale: z.string().min(1).max(500),
  })
  .superRefine((value, ctx) => {
    if (value.subject === "entity" && !value.subjectRef) {
      ctx.addIssue({
        code: "custom",
        path: ["subjectRef"],
        message: "entity propositions require subjectRef",
      });
    }

    if (value.subject === "user" && value.subjectRef !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["subjectRef"],
        message: "user propositions must not include subjectRef",
      });
    }
  });

export type ChatProposition = z.infer<typeof chatPropositionSchema>;

/** Max propositions per thread pass, a guard against a runaway model. */
export const MAX_CHAT_PROPOSITIONS = 20;

export const chatMemoryExtractionResultSchema = z.object({
  propositions: z.array(chatPropositionSchema).max(MAX_CHAT_PROPOSITIONS),
});

export type ChatMemoryExtractionResult = z.infer<typeof chatMemoryExtractionResultSchema>;
