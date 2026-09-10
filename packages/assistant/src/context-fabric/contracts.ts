import { z } from "zod";

/** Default evidence budget when a request omits `limit`. */
export const CONTEXT_SEARCH_DEFAULT_LIMIT = 10;

/**
 * Hard ceiling on evidence returned by one search. A read that wants more asks
 * again or drills into the provider; it does not grow this number.
 */
export const CONTEXT_SEARCH_MAX_LIMIT = 50;

/**
 * The Context Fabric read request (#422): a query/task envelope, not a tool
 * schema. Every field is bounded here so `searchContext` rejects a malformed
 * request before any source runs, and so the eventual model-facing
 * `system.search_context` tool (#426) derives its own bounded input from the
 * same shape.
 */
export const contextSearchRequestSchema = z.object({
  /** The user whose corpus is searched. */
  userId: z.string().min(1),
  /** Free-text retrieval query. */
  query: z.string().trim().min(1).max(4_000),
  /**
   * What the caller is trying to do, when it can say. An optional strategy hint
   * for sources — never a switch the fabric branches on.
   */
  task: z.string().trim().min(1).max(500).optional(),
  /** Maximum evidence items returned across all sources. */
  limit: z
    .number()
    .int()
    .min(1)
    .max(CONTEXT_SEARCH_MAX_LIMIT)
    .default(CONTEXT_SEARCH_DEFAULT_LIMIT),
});

export type ContextSearchRequest = z.infer<typeof contextSearchRequestSchema>;
