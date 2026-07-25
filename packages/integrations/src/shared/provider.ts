import type { RetryPolicy } from "./retry";

/**
 * The single source of truth for what any provider client needs to bind to a
 * user — the shape the facade's callable, its options type, and every provider
 * factory all derive from, so `userId` + `retry` are declared exactly once.
 * Lives in `shared/` (not `facade.ts`) so a provider client can reference it
 * without importing the facade that imports the client.
 *
 * A bind holds no credential and imposes no lifetime rule. Nothing a bind
 * memoizes ({@link once}) is a secret: it memoizes CLIENT CONSTRUCTION, so
 * touching `.github` twice yields one client, while every credential is resolved
 * per request through its own cache/refresh path. A bind held past the request it
 * was made for keeps working, because there is nothing stale in it to keep.
 */
export interface ProviderBindOptions {
  userId: string;
  /**
   * Transient-retry envelope for this bind's retry-safe requests, or `"none"` for
   * exactly one attempt.
   *
   * Required, and no default lives below this line. An optional field whose
   * absence meant "retry with the built-in policy" made two things invisible at
   * the call site: whether a provider retries at all, and the worst-case wall
   * time of one tool call (attempts × the transport timeout + backoff) — which is
   * the number that has to stay under the caller's own ceiling.
   */
  retry: RetryPolicy | "none";
}

/** The uniform provider-factory shape: bind options in, a configured client out. */
export type ProviderFactory = (options: ProviderBindOptions) => object;

/**
 * Bind-scoped memoization: run `build` on first call, then return that same
 * result for the lifetime of the returned thunk.
 *
 * Used for exactly one thing — CLIENT CONSTRUCTION in the facade, so touching
 * `.github` twice yields one client rather than one per property access. It is
 * deliberately NOT used to memoize a credential resolve: a memo with no expiry
 * wrapped around a token with one turns "resolved fresh" into a rule about how
 * long the caller may hold the bind, enforced by nothing. Freshness stays where
 * it can actually be reasoned about — the provider's own cache/refresh path.
 *
 * The async properties (one in-flight promise for concurrent callers, a cached
 * rejection) come free from memoizing the promise and are pinned by tests, so a
 * future caller can rely on them; nothing in this package needs them today.
 */
export function once<T>(build: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => {
    cached ??= { value: build() };
    return cached.value;
  };
}
