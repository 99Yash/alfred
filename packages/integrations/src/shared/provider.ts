import type { RetryPolicy } from "./retry";

/**
 * The single source of truth for what any provider client needs to bind to a
 * user — the shape the facade's callable, its options type, and every provider
 * factory all derive from, so `userId` + `retry` are declared exactly once.
 * Lives in `shared/` (not `facade.ts`) so a provider client can reference it
 * without importing the facade that imports the client.
 */
export interface ProviderBindOptions {
  userId: string;
  /** Transient-retry envelope applied to the provider's reads. */
  retry?: RetryPolicy;
}

/** The uniform provider-factory shape: bind options in, a configured client out. */
export type ProviderFactory = (options: ProviderBindOptions) => object;
