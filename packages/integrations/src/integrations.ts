import { githubClientForUser } from "./github/client";
import { googleClientForUser } from "./google/client";
import { sentryClientForUser } from "./sentry/client";
import { vercelClientForUser } from "./vercel/client";

import { hasEveryKey, typedKeys, type CredentialProvider } from "@alfred/contracts";
import { once, type ProviderBindOptions, type ProviderFactory } from "./shared/provider";

/**
 * Bind a user once and get every provider client for that user:
 * `integrations({ userId }).github.search({ q })`. Tools get it as `ctx.integrations`
 * and never hold a token.
 *
 * Each provider is a lazy getter, memoized per bind. Only the client is memoized,
 * never a credential, so an old bind cannot return a stale token.
 */

/**
 * Keyed by `CredentialProvider` (ADR-0093), so a missing or unknown provider is a
 * compile error. `satisfies` keeps each entry's exact return type for {@link Integrations}.
 */
const providerRegistry = {
  github: githubClientForUser,
  google: googleClientForUser,
  sentry: sentryClientForUser,
  vercel: vercelClientForUser,
} satisfies Record<CredentialProvider, ProviderFactory>;

type ProviderRegistry = typeof providerRegistry;

export type Integrations = {
  readonly [K in keyof ProviderRegistry]: ReturnType<ProviderRegistry[K]>;
};

/** Cheap: no client is built and no credential read until a method runs. */
export function integrations(options: ProviderBindOptions): Integrations {
  const bound: Partial<Integrations> = {};
  const providers = typedKeys(providerRegistry);

  for (const key of providers) {
    const build = once(() => providerRegistry[key](options));
    Object.defineProperty(bound, key, { enumerable: true, get: build });
  }

  // The loop above defines every provider, so this cannot fail. It reads no getter.
  if (!hasEveryKey(bound, providers)) throw new Error("integrations: a provider has no getter");

  return bound;
}
