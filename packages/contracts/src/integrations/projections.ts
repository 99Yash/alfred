/**
 * Slug-keyed tables derived from the registry. Add one only when a consumer needs
 * every slug at once. Otherwise read the field off `INTEGRATIONS[slug]`.
 */

import { pluckField, recordFromKeys } from "../records";
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

/** Literal action tuples by slug. `ActionSlug` and `ToolName` derive from this. */
export type IntegrationActions = {
  readonly [K in IntegrationSlug]: IntegrationEntryOf<K>["actions"];
};

export const INTEGRATION_ACTIONS: IntegrationActions = pluckField(INTEGRATIONS, "actions");

/** For an unchecked string, call `integrationDisplayName` from `../tools`. */
export const INTEGRATION_DISPLAY_NAMES: Readonly<Record<IntegrationSlug, string>> = recordFromKeys(
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
  // SAFETY: each element is the member for its own slug. TypeScript cannot pair a spread of
  // `INTEGRATIONS[slug]` with the member for `slug`, even with a generic slug (a correlated union).
  (slug) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a correlated union TypeScript cannot pair
    ({ slug, provider: credentialProviderOf(slug), ...INTEGRATIONS[slug] }) as LiveProviderEntry,
);
