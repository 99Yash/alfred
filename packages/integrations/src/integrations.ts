import { githubClientForUser } from "./github/client";
import { googleClientForUser } from "./google/client";
import { notionClientForUser } from "./notion/client";
import { sentryClientForUser } from "./sentry/client";
import { vercelClientForUser } from "./vercel/client";

import type { CredentialProvider } from "@alfred/contracts";
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
  notion: notionClientForUser,
  sentry: sentryClientForUser,
  vercel: vercelClientForUser,
} satisfies Record<CredentialProvider, ProviderFactory>;

type ProviderRegistry = typeof providerRegistry;

export type Integrations = {
  readonly [K in keyof ProviderRegistry]: ReturnType<ProviderRegistry[K]>;
};

/** Cheap: no client is built and no credential read until a method runs. */
export function integrations(options: ProviderBindOptions): Integrations {
  // SAFETY: the loop below adds exactly one getter per registry key.
  const bound = {} as { [K in keyof ProviderRegistry]: ReturnType<ProviderRegistry[K]> };

  // SAFETY: the registry's keys are exactly keyof ProviderRegistry.
  for (const key of Object.keys(providerRegistry) as (keyof ProviderRegistry)[]) {
    const build = once(() => providerRegistry[key](options));
    Object.defineProperty(bound, key, { enumerable: true, get: build });
  }

  return bound;
}
