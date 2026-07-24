import { githubClientForUser } from "./github/client";
import { vercelClientForUser } from "./vercel/client";

import type { ProviderBindOptions, ProviderFactory } from "./shared/provider";

/**
 * PROTOTYPE — the unified integration facade. One callable binds a user once and
 * hands back every provider client already wired to *that user's* credentials,
 * so a call site reads as one continuous thought:
 *
 *   integrations({ userId }).github.search({ q })
 *
 * Design properties:
 *
 *   1. The user binds at the *root*, not per method. Binding is cheap and holds
 *      no secret — each provider is a lazily-built client over a token
 *      *resolver*, so tokens are minted fresh per call through the real
 *      cache/refresh path. The facade binds a *user*, never a token.
 *
 *   2. Each provider is a lazy `get`ter, so touching `.github` builds only the
 *      GitHub client — the facade never eagerly constructs providers you don't
 *      use.
 *
 *   3. It is GENERIC over a provider registry, and the binding shape is declared
 *      ONCE ({@link ProviderBindOptions}): the root's options, the factory
 *      signature, and each client all derive from it — no `{ userId, retry }`
 *      restated per provider. Adding a provider is a single {@link providerRegistry}
 *      entry; the public {@link Integrations} type is *derived* (`ReturnType` per
 *      entry), never a hand-maintained parallel interface.
 *
 * The discipline that keeps this from drifting into an API mirror: each provider
 * exposes the same small curated method set it always had (ADR-0071), not a
 * generated surface. Cross-integration "what happened everywhere" is #422, not a
 * method here.
 */

/** The facade's bind options — the one shared shape, surfaced under a call-site name. */
export type IntegrationsOptions = ProviderBindOptions;

/**
 * The single source of truth for which providers the facade exposes. Add a
 * provider here and its client type flows into {@link Integrations} automatically
 * — there is no second place to update. `satisfies` enforces the uniform factory
 * signature while preserving each entry's precise return type for the derivation.
 * Because every client factory already takes {@link ProviderBindOptions}, entries
 * are bare references — no per-provider adapter glue.
 */
const providerRegistry = {
  github: githubClientForUser,
  vercel: vercelClientForUser,
} satisfies Record<string, ProviderFactory>;

type ProviderRegistry = typeof providerRegistry;

/** Derived, never hand-written: each provider key maps to its client's exact type. */
export type Integrations = {
  readonly [K in keyof ProviderRegistry]: ReturnType<ProviderRegistry[K]>;
};

/**
 * The call-site entry point: `integrations({ userId }).github.search({ q })`.
 * Cheap to call and holds no secret — every provider underneath resolves a fresh
 * token per request. Built generically from {@link providerRegistry}, so the
 * chain is fully typed for every registered provider without per-provider glue.
 */
export function integrations(options: IntegrationsOptions): Integrations {
  const facade = {} as { [K in keyof ProviderRegistry]: ReturnType<ProviderRegistry[K]> };
  for (const key of Object.keys(providerRegistry) as (keyof ProviderRegistry)[]) {
    Object.defineProperty(facade, key, {
      enumerable: true,
      // Localized cast: iterating string keys collapses the registry to a union
      // of factory types; the uniform signature makes the call safe, and the
      // public return type stays precise per key via the mapped type above.
      get: () => (providerRegistry[key] as ProviderFactory)(options),
    });
  }
  return facade;
}
