/**
 * Slug-keyed tables derived from the registry. Add one only when a consumer needs
 * every slug at once. Otherwise read the field off `INTEGRATIONS[slug]`.
 */

import {
  INTEGRATION_SLUGS,
  INTEGRATIONS,
  type IntegrationEntryOf,
  type IntegrationSlug,
  type LiveIntegrationEntry,
} from "./registry";
import {
  credentialProviderOf,
  LIVE_PROVIDER_SLUGS,
  type CredentialProvider,
  type LiveProviderSlug,
} from "./slugs";

/** Build a record over a slug list. */
export function projectSlugs<K extends string, T>(
  slugs: readonly K[],
  project: (slug: K) => T,
): Readonly<Record<K, T>> {
  // SAFETY: the keys are exactly `slugs`; Object.fromEntries erases that.
  return Object.fromEntries(slugs.map((slug) => [slug, project(slug)])) as Record<K, T>;
}

/** Literal action tuples by slug. `ActionSlug` and `ToolName` derive from this. */
export type IntegrationActions = {
  readonly [K in IntegrationSlug]: IntegrationEntryOf<K>["actions"];
};

export const INTEGRATION_ACTIONS: IntegrationActions =
  // SAFETY: the value under K is `INTEGRATIONS[K].actions` by construction.
  Object.fromEntries(
    INTEGRATION_SLUGS.map((slug) => [slug, INTEGRATIONS[slug].actions]),
  ) as IntegrationActions;

/** For an unchecked string, call `integrationDisplayName` from `../tools`. */
export const INTEGRATION_DISPLAY_NAMES: Readonly<Record<IntegrationSlug, string>> = projectSlugs(
  INTEGRATION_SLUGS,
  (slug) => INTEGRATIONS[slug].displayName,
);

/**
 * A live entry plus its slug and provider. The `LiveIntegrationEntry` intersection
 * puts back the optional fields that `as const` drops, so no `in` check is needed.
 */
export type LiveProviderEntry = {
  [K in LiveProviderSlug]: {
    readonly slug: K;
    readonly provider: CredentialProvider;
  } & IntegrationEntryOf<K> &
    LiveIntegrationEntry;
}[LiveProviderSlug];

/** Live providers in registry order. */
export const LIVE_PROVIDERS: readonly LiveProviderEntry[] = LIVE_PROVIDER_SLUGS.map(
  // SAFETY: each element is the member for its own slug. `map` cannot express that pairing.
  (slug) =>
    ({ slug, provider: credentialProviderOf(slug), ...INTEGRATIONS[slug] }) as LiveProviderEntry,
);
