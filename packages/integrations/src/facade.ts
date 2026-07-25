import { githubClientForUser } from "./github/client";
import { vercelClientForUser } from "./vercel/client";

import { once, type ProviderBindOptions, type ProviderFactory } from "./shared/provider";

/**
 * The unified integration facade. One callable binds a user once and hands back
 * every provider client already wired to *that user's* credentials, so a call
 * site reads as one continuous thought:
 *
 *   integrations({ userId }).github.search({ q })
 *
 * In production the bind happens once per tool dispatch and arrives at tool code
 * as `ctx.integrations` — so a tool never names a credential function, never
 * holds a token, and cannot bind the wrong user.
 *
 * Design properties:
 *
 *   1. The user binds at the *root*, not per method. Binding is cheap and holds
 *      no secret — each provider is a lazily-built client over a credential
 *      *resolver*, so a credential is resolved through the real cache/refresh
 *      path when a method actually runs. The facade binds a *user*, never a token.
 *
 *   2. Each provider is a memoized lazy `get`ter: touching `.github` builds only
 *      the GitHub client, and touching it twice yields the SAME client. The memo
 *      covers CLIENT CONSTRUCTION only — no credential is memoized anywhere below
 *      it, so a bind carries no expiry and no lifetime rule, and holding one past
 *      the request that made it cannot yield a stale token.
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
 *
 * INCOMPLETE, AND THE CLOCK IS NAMED — **#551 closes it**. Only `github` and
 * `vercel` are on the facade. Google, Notion, and Railway are still reached
 * through their credential functions (`getFreshAccessToken`,
 * `getActiveBearerCredential`), so until #551 lands there are two doors and a
 * caller has to know which one its provider uses. THIS is the door: a call site
 * that has a `ToolExecuteContext` uses `ctx.integrations`, and a provider missing
 * from {@link providerRegistry} is missing, not excluded. Do not add a new
 * credential-function call site for a provider that could join here instead.
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
  // google, notion, railway: #551. Each needs a `*ClientForUser` first — their
  // surfaces are still bare-`accessToken` function sets, not configured clients.
} satisfies Record<string, ProviderFactory>;

type ProviderRegistry = typeof providerRegistry;

/** Derived, never hand-written: each provider key maps to its client's exact type. */
export type Integrations = {
  readonly [K in keyof ProviderRegistry]: ReturnType<ProviderRegistry[K]>;
};

/**
 * The call-site entry point: `integrations({ userId }).github.search({ q })`.
 * Cheap to call and holds no secret — no provider is constructed and no
 * credential read until a method actually runs. Built generically from
 * {@link providerRegistry}, so the chain is fully typed for every registered
 * provider without per-provider glue.
 */
export function integrations(options: IntegrationsOptions): Integrations {
  const facade = {} as { [K in keyof ProviderRegistry]: ReturnType<ProviderRegistry[K]> };
  for (const key of Object.keys(providerRegistry) as (keyof ProviderRegistry)[]) {
    // Localized cast: iterating string keys collapses the registry to a union of
    // factory types; the uniform signature makes the call safe, and the public
    // return type stays precise per key via the mapped type above.
    const build = once(() => (providerRegistry[key] as ProviderFactory)(options));
    Object.defineProperty(facade, key, { enumerable: true, get: build });
  }
  return facade;
}
