/**
 * Context Search read envelope (epic #422; ADR-0101).
 *
 * The Context Search boundary takes one bounded query/task envelope. The
 * envelope lives here, in the browser-safe contracts package, because it is a
 * cross-boundary shape, not an implementation detail of the
 * `@alfred/assistant/context-search` module: the model-facing
 * `system.search_context` tool (#426) derives its bounded input from this same
 * schema and cap, and nothing else may grow a second envelope.
 */

import { z } from "zod";
import { objectIdentitySchema, objectProviderSchema } from "./object-identity";

/** Default evidence budget when a request omits `limit`. */
export const CONTEXT_SEARCH_DEFAULT_LIMIT = 10;

/**
 * Hard ceiling on evidence returned by one search. A read that wants more asks
 * again or drills into the provider; it does not grow this number.
 */
export const CONTEXT_SEARCH_MAX_LIMIT = 50;

/**
 * Hard ceiling on exact object references carried by one request. They are a
 * caller-declared set, not a retrieval result, so they are capped tighter than
 * the evidence budget; a caller with more asks again.
 */
export const CONTEXT_SEARCH_MAX_OBJECT_REFS = 25;

/**
 * Hard ceiling on live expansions one read may pay for (#1077).
 *
 * The expansion phase calls a provider per unique handle, so this is a WALL
 * CLOCK and money bound, not an evidence bound: it is much tighter than
 * {@link CONTEXT_SEARCH_MAX_LIMIT} because a read returns up to fifty cards but
 * must never turn into fifty provider round trips. Cards are considered in rank
 * order, so the cap keeps the strongest evidence and drops the refresh of the
 * weakest.
 */
export const CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS = 5;

/**
 * An exact reference to a work object by one of its sidecar keys (#425). The key
 * index (`head_sha → pull_request`) is the deterministic bridge that a fuzzy
 * query cannot supply, so the caller states it directly.
 */
export const contextObjectKeyRefSchema = z.object({
  by: z.literal("key"),
  /**
   * Integration slug — `github`, later `clickup`. Reuses the object-identity
   * provider schema so the bounds and the description stay one definition.
   */
  provider: objectProviderSchema,
  /** Key kind within the provider — `head_sha`. */
  keyKind: z
    .string()
    .min(1)
    .max(100)
    .describe("Provider-declared key kind to resolve, for example `head_sha`."),
  /** Provider-declared key value, as a string. */
  keyValue: z
    .string()
    .min(1)
    .max(512)
    .describe("Provider-declared key value to resolve, as a string."),
});

export type ContextObjectKeyRef = z.infer<typeof contextObjectKeyRefSchema>;

/**
 * An exact reference to a work object by its provider-native identity — the
 * `(provider, kind, externalId)` tuple the object store is uniquely keyed on.
 */
export const contextObjectIdentityRefSchema = objectIdentitySchema.extend({
  by: z.literal("identity"),
});

export type ContextObjectIdentityRef = z.infer<typeof contextObjectIdentityRefSchema>;

/**
 * One exact object reference. A discriminated union so the two lookup paths are
 * never ambiguous: `by: "key"` resolves through the key index, `by: "identity"`
 * reads the object row directly.
 */
export const contextObjectRefSchema = z.discriminatedUnion("by", [
  contextObjectKeyRefSchema,
  contextObjectIdentityRefSchema,
]);

export type ContextObjectRef = z.infer<typeof contextObjectRefSchema>;

/**
 * The Context Search read request: a query/task envelope, not a tool schema.
 * Every field is bounded here so `searchContext` rejects a malformed request
 * before any source runs.
 */
export const contextSearchRequestSchema = z.object({
  /** The user whose corpus is searched. */
  userId: z.string().min(1),
  /** Free-text retrieval query. */
  query: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe(
      "What you want to find, phrased as the question or fact you are looking for — not a bag of keywords. The boundary searches across every registered evidence source with it.",
    ),
  /**
   * What the caller is trying to do, when it can say. An optional strategy hint
   * for sources — never a switch the boundary branches on.
   */
  task: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Optional one-line statement of what you are trying to do with the evidence (for example, "prepare for tomorrow\'s meeting with X"). Sources may use it to aim retrieval; they never branch on it.',
    ),
  /**
   * Exact object references the caller already knows, for deterministic
   * object-state evidence (#425). Additive to `query`, not a replacement: a
   * vector source still reads `query`, and an exact-reference source reads these
   * instead of inferring identity from text. Absent or empty means "no exact
   * lookup requested", never "look something up fuzzily".
   */
  objects: z
    .array(contextObjectRefSchema)
    .max(CONTEXT_SEARCH_MAX_OBJECT_REFS)
    .optional()
    .describe(
      "Exact work-object references you already hold (a GitHub pull request, an integration object by provider identity or key). Additive to `query`, for deterministic state lookups; omit when you only have a free-text question.",
    ),
  /**
   * Whether the read may refresh a surviving card from its live source (#1077).
   *
   * On by default, because a stale card the boundary could have refreshed is a
   * worse answer than a slow one. A caller that cannot pay a provider round
   * trip — a background job on a budget, a latency-bound path — sets it to
   * `false` and gets the local cards alone. It is a switch on the PHASE, never
   * on a source: turning it off skips every expander at once.
   */
  expand: z
    .boolean()
    .default(true)
    .describe(
      `Whether the read may refresh up to ${CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS} of the surviving cards from their live source. Set it to false to skip every provider round trip and take the local copies alone.`,
    ),
  /** Maximum evidence items returned across all sources. */
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
