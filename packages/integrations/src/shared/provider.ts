import type { RetryPolicy } from "./retry";

/**
 * The single source of truth for what any provider client needs to bind to a
 * user — the shape the facade's callable, its options type, and every provider
 * factory all derive from, so `userId` + `retry` are declared exactly once.
 * Lives in `shared/` (not `facade.ts`) so a provider client can reference it
 * without importing the facade that imports the client.
 *
 * LIFETIME — a bind is REQUEST-SCOPED. Everything a bind memoizes (see
 * {@link once}) lives exactly as long as the bound object, so binding once per
 * unit of work (in production: once per tool dispatch, from `ToolExecuteContext`)
 * is what makes "credentials resolved fresh" true. A bind held at module scope
 * would pin whatever it resolved on its first call; use the resolver-injection
 * constructor (`createGithubClient`, `createVercelClient`) for anything
 * longer-lived than a request.
 */
export interface ProviderBindOptions {
  userId: string;
  /** Transient-retry envelope applied to the provider's reads. */
  retry?: RetryPolicy;
}

/** The uniform provider-factory shape: bind options in, a configured client out. */
export type ProviderFactory = (options: ProviderBindOptions) => object;

/**
 * Bind-scoped memoization: run `build` on first call, then return that same
 * result for the lifetime of the returned thunk.
 *
 * The one thing every level of a bind needs and none of them should hand-roll:
 * the facade uses it so touching `.github` twice yields ONE client, and a
 * client uses it so a method pair like `connectedLogin()` + `search()` costs one
 * credential resolve instead of two. Memoizing an async `build` caches the
 * *promise*, which also collapses concurrent callers onto a single in-flight
 * resolve.
 *
 * A rejected promise stays cached — deliberate: within one request a credential
 * that could not be resolved will not resolve a moment later, and re-running the
 * lookup per method would turn one failure into N. The failure surfaces at every
 * call site that needed it, which is the honest outcome.
 */
export function once<T>(build: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => {
    cached ??= { value: build() };
    return cached.value;
  };
}
