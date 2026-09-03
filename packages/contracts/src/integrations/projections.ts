/**
 * Slug-keyed tables built from the registry in record order. None is
 * hand-typed. `Object.fromEntries` erases the key set, so each carries one
 * cast that restores it.
 *
 * `INTEGRATION_ACTIONS` and `INTEGRATION_DISPLAY_NAMES` are permanent views.
 * `CREDENTIAL_SHAPE`, `GENERAL_INVOCATION_COVERAGE`, and `PASSTHROUGH_TRANSPORT`
 * are transitional: their consumers move to the entry fields in PR 2 and PR 3
 * of the registry plan, and PR 4 deletes them.
 */

import {
  INTEGRATION_SLUGS,
  INTEGRATIONS,
  type IntegrationEntryOf,
  type IntegrationSlug,
} from "./registry";
import {
  credentialProviderOf,
  LIVE_PROVIDER_SLUGS,
  LOADABLE_INTEGRATION_SLUGS,
  SUPPORTED_PASSTHROUGH_SLUGS,
  type CredentialProvider,
  type LiveProviderSlug,
  type LoadableIntegrationSlug,
  type SupportedPassthroughSlug,
} from "./slugs";
import type { CredentialSpec, LiveIntegrationEntry, PassthroughTransportKind } from "./types";

function projectSlugs<K extends string, T>(
  slugs: readonly K[],
  project: (slug: K) => T,
): Readonly<Record<K, T>> {
  // SAFETY: the result has exactly the keys in `slugs`; Object.fromEntries'
  // string index erases that and this cast restores it. Each caller passes the
  // derived list its K is defined from.
  return Object.fromEntries(slugs.map((slug) => [slug, project(slug)])) as Record<K, T>;
}

/**
 * Every integration's action tuple under its slug, with each entry's literal
 * types kept, so `ActionSlug<I>` and `ToolName` in `../tools` derive from it.
 */
export type IntegrationActions = {
  readonly [K in IntegrationSlug]: IntegrationEntryOf<K>["actions"];
};

export const INTEGRATION_ACTIONS: IntegrationActions =
  // SAFETY: same key-set restoration as `projectSlugs`, per key rather than
  // uniform: the value under K is `INTEGRATIONS[K].actions` by construction.
  Object.fromEntries(
    INTEGRATION_SLUGS.map((slug) => [slug, INTEGRATIONS[slug].actions]),
  ) as IntegrationActions;

/**
 * The display name of every integration, for prose a user or the model reads
 * (a failure message, a connect nudge). Index it with a typed slug, or call
 * `integrationDisplayName(value)` from `../tools` for an unchecked string.
 */
export const INTEGRATION_DISPLAY_NAMES: Readonly<Record<IntegrationSlug, string>> = projectSlugs(
  INTEGRATION_SLUGS,
  (slug) => INTEGRATIONS[slug].displayName,
);

/**
 * A live entry with its slug and credential provider attached, discriminated by
 * slug. `as const` drops an optional field from the entries that do not set it,
 * so each member is also intersected with `LiveIntegrationEntry`: the `as const`
 * fields stay narrow, and every optional the interface declares is readable on
 * every member without an `in` check.
 */
export type LiveProviderEntry = {
  [K in LiveProviderSlug]: {
    readonly slug: K;
    readonly provider: CredentialProvider;
  } & IntegrationEntryOf<K> &
    LiveIntegrationEntry;
}[LiveProviderSlug];

/** The live providers in registry order: the one loop the assistant and the web iterate. */
export const LIVE_PROVIDERS: readonly LiveProviderEntry[] = LIVE_PROVIDER_SLUGS.map(
  // SAFETY: `slug` is drawn from LIVE_PROVIDER_SLUGS and the entry is
  // `INTEGRATIONS[slug]`, so each element is exactly the member for its own K.
  // `map` instantiates the callback with the wide union and cannot express
  // that per-element pairing.
  (slug) =>
    ({ slug, provider: credentialProviderOf(slug), ...INTEGRATIONS[slug] }) as LiveProviderEntry,
);

// ---------------------------------------------------------------------------
// Transitional tables. Deleted in PR 4 of the registry plan.
// ---------------------------------------------------------------------------

/**
 * @deprecated Read `INTEGRATIONS[slug].kind`, `.status`, and
 * `.credential.shape` instead. `deferred` is a `planned` provider;
 * `not_applicable` is a channel. Deleted in PR 4 of the registry plan.
 */
export type CredentialShape = CredentialSpec["shape"] | "deferred" | "not_applicable";

/** @deprecated Read `INTEGRATIONS[slug].credential.shape`. Deleted in PR 4 of the registry plan. */
export const CREDENTIAL_SHAPE: Readonly<Record<LoadableIntegrationSlug, CredentialShape>> =
  projectSlugs(LOADABLE_INTEGRATION_SLUGS, (slug) => {
    const entry = INTEGRATIONS[slug];
    if (entry.kind === "channel") return "not_applicable";
    return entry.status === "planned" ? "deferred" : entry.credential.shape;
  });

/** @deprecated Read `INTEGRATIONS[slug].passthrough`. Deleted in PR 4 of the registry plan. */
export type CoverageDecision = "supported" | "deferred" | "not_applicable";

/** @deprecated Read `INTEGRATIONS[slug].passthrough`. Deleted in PR 4 of the registry plan. */
export const GENERAL_INVOCATION_COVERAGE: Readonly<
  Record<LoadableIntegrationSlug, CoverageDecision>
> = projectSlugs(LOADABLE_INTEGRATION_SLUGS, (slug) => {
  const entry = INTEGRATIONS[slug];
  if (entry.kind === "channel") return "not_applicable";
  if (entry.status === "planned") return "deferred";
  return entry.passthrough === null ? "not_applicable" : "supported";
});

/** @deprecated Read `INTEGRATIONS[slug].passthrough.transport`. Deleted in PR 4 of the registry plan. */
export const PASSTHROUGH_TRANSPORT: Readonly<
  Record<SupportedPassthroughSlug, PassthroughTransportKind>
> = projectSlugs(SUPPORTED_PASSTHROUGH_SLUGS, (slug) => INTEGRATIONS[slug].passthrough.transport);
