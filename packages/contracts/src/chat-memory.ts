/**
 * Chat → memory capture v1 — the tagged proposition the end-of-thread
 * extractor emits (chat-memory-capture-v1.md, #398; decisions D4/D6).
 *
 * This is the boundary shape between the extractor (#398, this slice) and the
 * observation writer (#399): a CRISP, nameable proposition distilled from a
 * finished chat transcript, tagged with the two orthogonal epistemic axes D4
 * defines (verification route + volatility) plus how it should be attributed
 * back into the ADR-0067 observation log. #398 only PRODUCES these — no durable
 * write happens here; #399 maps `attribution` onto an `(OBSERVATION_SOURCE,
 * OBSERVATION_KIND)` pair and routes it through `insertObservation`.
 *
 * Pure, web-safe module (kept out of the already-large `user-model.ts`); reuses
 * `factSubjectKindSchema` and `confidenceSchema` from the existing contract
 * surface rather than re-declaring them.
 */

import { z } from "zod";
import { confidenceSchema } from "./model-output";

/**
 * The value a proposition carries. Deliberately NOT the recursive
 * `jsonValueSchema`: this schema is handed to the cheap-model structured-output
 * path (`Output.object`), which chokes on recursive/`$ref` JSON schemas (same
 * portability constraint that forces {@link confidenceSchema} to be a bare
 * number). A proposition's value is "the simplest correct shape" (D6) — an
 * atomic primitive, or a shallow object of primitives (e.g. a relationship
 * `{ role, since? }`) — so a one-level union covers every real case while
 * staying structured-output-safe. Deeper structure is out of scope for v1.
 */
export const propositionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
]);
export type PropositionValue = z.infer<typeof propositionValueSchema>;

/**
 * D4 — the *verification route* for a proposition (how, if at all, Alfred can
 * confirm it):
 *   - `self_evident`          — no source needed (the user's own nickname).
 *   - `integration_checkable` — confirmable against connected data, no user and
 *                               (per D5) zero tokens (a deterministic SQL/API check).
 *   - `external_checkable`    — needs the web / an authoritative outside source.
 *   - `user_only`             — subjective/private; only the user attests it.
 * This slice only TAGS the route; the budget-gated active verification itself
 * is #400 (D5).
 */
export const VERIFICATION_CLASSES = [
  "self_evident",
  "integration_checkable",
  "external_checkable",
  "user_only",
] as const;
export const verificationClassSchema = z.enum(VERIFICATION_CLASSES);
export type VerificationClass = (typeof VERIFICATION_CLASSES)[number];

/**
 * D4 — the proposition's *volatility*, orthogonal to its verification route:
 *   - `stable`   — unlikely to change (a name, "co-founder of").
 *   - `volatile` — expected to drift (headcount, current title/company) and so
 *                  carries a re-verification / `valid_until` window downstream.
 */
export const VOLATILITY_CLASSES = ["stable", "volatile"] as const;
export const volatilitySchema = z.enum(VOLATILITY_CLASSES);
export type Volatility = (typeof VOLATILITY_CLASSES)[number];

/**
 * How the proposition should be attributed when #399 writes it as an
 * observation. These classes capture the *correction arc* D1/D9 exist to
 * preserve — a fresh extractor reading the closed thread can see the user
 * asserting, confirming, correcting, or rejecting a claim, and distinguishes
 * all of those from something Alfred merely inferred (e.g. from a web search).
 *
 * The mapping onto the concrete `(OBSERVATION_SOURCE, OBSERVATION_KIND)` pair
 * (`user`/`alfred_chat` + `user_correction`/`user_confirmation`/…; `enrichment`
 * + `enrichment_fact`) is deliberately NOT encoded here — it lives with the
 * observation writer in #399 so this extractor stays free of the write
 * boundary. See `OBSERVATION_KINDS_BY_SOURCE` in `user-model.ts`.
 */
export const PROPOSITION_ATTRIBUTIONS = [
  /** User stated a new fact about themselves or an entity. */
  "user_assertion",
  /** User corrected a claim Alfred (or a prior turn) had made. */
  "user_correction",
  /** User affirmed an existing/proposed claim. */
  "user_confirmation",
  /** User rejected a claim. */
  "user_rejection",
  /** Alfred inferred it (e.g. from a web lookup) — provisional, decays. */
  "alfred_enrichment",
] as const;
export const propositionAttributionSchema = z.enum(PROPOSITION_ATTRIBUTIONS);
export type PropositionAttribution = (typeof PROPOSITION_ATTRIBUTIONS)[number];

/**
 * A single crisp proposition distilled from a finished chat thread (D6). Kept
 * as one flat object instead of a discriminated union because this schema is
 * model-facing: `z.discriminatedUnion` + `z.never()` emits JSON Schema
 * `oneOf`/`not`, which is brittle in provider structured-output paths. The
 * branch invariant is enforced by `superRefine` after generation.
 */
export const chatPropositionSchema = z
  .object({
    /** The proposition's subject. Entity propositions must carry `subjectRef`. */
    subject: z.enum(["user", "entity"]),
    /**
     * The entity as the model referred to it (an email, a display name like
     * "dvd"/"Venkata Deepankar Duvvuru", …). Omitted for user propositions.
     */
    subjectRef: z.string().min(1).max(200).optional(),
    /**
     * The proposition's key. The extractor emits its best snake_case guess
     * (`employer`, `job_title`, `relationship:dvd@oliv.ai`, `pref:tone`, …); the
     * projection canonicalizes it against the fact ontology later.
     */
    key: z.string().min(1).max(200),
    /** The value — the simplest correct JSON shape (string or shallow object). */
    value: propositionValueSchema,
    /** D4 verification route. */
    verificationClass: verificationClassSchema,
    /** D4 volatility. */
    volatility: volatilitySchema,
    /** How #399 should attribute the observation (the correction arc). */
    attribution: propositionAttributionSchema,
    /** Model confidence in the proposition (0–1). */
    confidence: confidenceSchema,
    /** Short justification grounded in the transcript — for audit + debugging bad proposals. */
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

/**
 * Upper bound on propositions per thread pass. A single conversation yields a
 * handful of durable truths at most; the cap is a guardrail against a
 * misbehaving model emitting a huge blob (mirrors `extractionResultSchema`).
 */
export const MAX_CHAT_PROPOSITIONS = 20;

export const chatMemoryExtractionResultSchema = z.object({
  propositions: z.array(chatPropositionSchema).max(MAX_CHAT_PROPOSITIONS),
});
export type ChatMemoryExtractionResult = z.infer<typeof chatMemoryExtractionResultSchema>;
