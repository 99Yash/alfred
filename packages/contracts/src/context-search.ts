/**
 * The one Context Search request envelope (ADR-0101).
 * `system.search_context` derives its input from it; do not add a second envelope.
 */

import { z } from "zod";
import { objectIdentitySchema, objectProviderSchema } from "./object-identity";
import { sourceCostBudgetSchema } from "./source-manifest";

/** Default evidence budget when a request omits `limit`. */
export const CONTEXT_SEARCH_DEFAULT_LIMIT = 10;

/** Max evidence per search. A caller that wants more asks again. */
export const CONTEXT_SEARCH_MAX_LIMIT = 50;

/** Max exact object references per request. */
export const CONTEXT_SEARCH_MAX_OBJECT_REFS = 25;

/**
 * Max provider round trips one read pays for in the expansion phase.
 * Cards go in rank order, so the cap drops the weakest refreshes. Time is bounded separately.
 */
export const CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS = 5;

/**
 * Deadline for the expansion phase. Expanders run in parallel, so one hung provider would hang the read.
 * A timed-out expansion keeps its original card and reports a timeout.
 */
export const CONTEXT_SEARCH_EXPANSION_TIMEOUT_MS = 10_000;

/**
 * Deadline for the collect phase. Per-fetch timeouts can stack back to back,
 * so the phase aborts here and reports a timeout per unanswered source.
 */
export const CONTEXT_SEARCH_COLLECT_TIMEOUT_MS = 10_000;

/** An exact object reference by a sidecar key, e.g. a `head_sha` that resolves to a pull request. */
export const contextObjectKeyRefSchema = z.object({
  by: z.literal("key"),
  provider: objectProviderSchema,
  keyKind: z
    .string()
    .min(1)
    .max(100)
    .describe("Provider-declared key kind to resolve, for example `head_sha`."),
  keyValue: z
    .string()
    .min(1)
    .max(512)
    .describe("Provider-declared key value to resolve, as a string."),
});

export type ContextObjectKeyRef = z.infer<typeof contextObjectKeyRefSchema>;

/** An exact object reference by its `(provider, kind, externalId)` identity. */
export const contextObjectIdentityRefSchema = objectIdentitySchema.extend({
  by: z.literal("identity"),
});

export type ContextObjectIdentityRef = z.infer<typeof contextObjectIdentityRefSchema>;

/** One exact object reference: `key` goes through the key index, `identity` reads the row. */
export const contextObjectRefSchema = z.discriminatedUnion("by", [
  contextObjectKeyRefSchema,
  contextObjectIdentityRefSchema,
]);

export type ContextObjectRef = z.infer<typeof contextObjectRefSchema>;

/** The Context Search request. Every field is bounded, so a bad request fails before any source runs. */
export const contextSearchRequestSchema = z.object({
  userId: z.string().min(1),
  query: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe(
      "What you want to find, phrased as the question or fact you are looking for — not a bag of keywords. The boundary searches across every registered evidence source with it.",
    ),
  task: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Optional one-line statement of what you are trying to do with the evidence (for example, "prepare for tomorrow\'s meeting with X"). Sources may use it to aim retrieval; they never branch on it.',
    ),
  objects: z
    .array(contextObjectRefSchema)
    .max(CONTEXT_SEARCH_MAX_OBJECT_REFS)
    .optional()
    .describe(
      "Exact work-object references you already hold (a GitHub pull request, an integration object by provider identity or key). Additive to `query`, for deterministic state lookups; omit when you only have a free-text question.",
    ),
  /** On by default: a stale card is worse than a slow one. */
  expand: z
    .boolean()
    .default(true)
    .describe(
      `Whether the read may refresh up to ${CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS} of the surviving cards from their live source. Set it to false to skip every provider round trip and take the local copies alone.`,
    ),
  /**
   * Cost budget for the collect phase; `expand` covers the second phase.
   * A budget over declared cost, never a source list. An excluded source is reported.
   */
  maxSourceCost: sourceCostBudgetSchema
    .default("remote")
    .describe(
      "The most one evidence source may cost before this read declines to ask it: `local` reads only local tables, `metered` also pays for an embedding, and `remote` (the default) also calls a provider.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CONTEXT_SEARCH_MAX_LIMIT)
    .default(CONTEXT_SEARCH_DEFAULT_LIMIT)
    .describe(
      `Maximum number of evidence items returned across all sources (${CONTEXT_SEARCH_DEFAULT_LIMIT} by default, ${CONTEXT_SEARCH_MAX_LIMIT} max).`,
    ),
});

export type ContextSearchRequest = z.infer<typeof contextSearchRequestSchema>;
