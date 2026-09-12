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
 * An exact reference to a work object by one of its sidecar keys (#425). The key
 * index (`head_sha → pull_request`) is the deterministic bridge that a fuzzy
 * query cannot supply, so the caller states it directly.
 */
export const contextObjectKeyRefSchema = z.object({
  by: z.literal("key"),
  /** Integration slug — `github`, later `clickup`. */
  provider: z.string().min(1).max(100),
  /** Key kind within the provider — `head_sha`. */
  keyKind: z.string().min(1).max(100),
  /** Provider-declared key value, as a string. */
  keyValue: z.string().min(1).max(512),
});

export type ContextObjectKeyRef = z.infer<typeof contextObjectKeyRefSchema>;

/**
 * An exact reference to a work object by its provider-native identity — the
 * `(provider, kind, externalId)` tuple the object store is uniquely keyed on.
 */
export const contextObjectIdentityRefSchema = z.object({
  by: z.literal("identity"),
  /** Integration slug — `github`, later `clickup`. */
  provider: z.string().min(1).max(100),
  /** Object kind within the provider — `pull_request`. */
  kind: z.string().min(1).max(100),
  /** Provider-native stable id, as a string. */
  externalId: z.string().min(1).max(512),
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
  query: z.string().trim().min(1).max(4_000),
  /**
   * What the caller is trying to do, when it can say. An optional strategy hint
   * for sources — never a switch the boundary branches on.
   */
  task: z.string().trim().min(1).max(500).optional(),
  /**
   * Exact object references the caller already knows, for deterministic
   * object-state evidence (#425). Additive to `query`, not a replacement: a
   * vector source still reads `query`, and an exact-reference source reads these
   * instead of inferring identity from text. Absent or empty means "no exact
   * lookup requested", never "look something up fuzzily".
   */
  objects: z.array(contextObjectRefSchema).max(CONTEXT_SEARCH_MAX_OBJECT_REFS).optional(),
  /** Maximum evidence items returned across all sources. */
  limit: z
    .number()
    .int()
    .min(1)
    .max(CONTEXT_SEARCH_MAX_LIMIT)
    .default(CONTEXT_SEARCH_DEFAULT_LIMIT),
});

export type ContextSearchRequest = z.infer<typeof contextSearchRequestSchema>;
