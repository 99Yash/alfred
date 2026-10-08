import type { RetryPolicy } from "./retry";

/**
 * What every provider client needs to bind to a user. In `shared/` so a client can
 * import it without importing the root that imports the client.
 */
export interface ProviderBindOptions {
  userId: string;
  /** Exact provider account id approved for this tool call, when one is pinned. */
  accountRef?: string | undefined;
  /**
   * Required, with no default below, so the call site shows whether a provider retries
   * and the worst-case wall time of one call.
   */
  retry: RetryPolicy | "none";
}

export type ProviderFactory = (options: ProviderBindOptions) => object;

/**
 * Run `build` once and return the same result after. Memoize client construction only,
 * never a credential: a memo has no expiry, and a token does.
 */
export function once<T>(build: () => T): () => T {
  let cached: { value: T } | undefined;

  return () => {
    cached ??= { value: build() };

    return cached.value;
  };
}
