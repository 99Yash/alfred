/**
 * The slug unions and slug lists derived from the registry. Every union is a
 * mapped conditional over the record, never a hand-listed tuple. Every runtime
 * list is a `filter` over `INTEGRATION_SLUGS` with a predicate that reads the
 * record, then an `enumGuard`, so a list and its union cannot disagree.
 */

import { enumGuard } from "../guards";
import {
  INTEGRATION_SLUGS,
  INTEGRATIONS,
  type IntegrationEntryOf,
  type IntegrationSlug,
} from "./registry";
import type { PassthroughTransportKind } from "./types";

/** The slugs whose entry extends `P`. */
export type SlugsWhere<P> = {
  [K in IntegrationSlug]: IntegrationEntryOf<K> extends P ? K : never;
}[IntegrationSlug];

export type InternalIntegrationSlug = SlugsWhere<{ kind: "internal" }>;
export type ChannelIntegrationSlug = SlugsWhere<{ kind: "channel" }>;
export type LiveProviderSlug = SlugsWhere<{ kind: "provider"; status: "live" }>;
export type PlannedSlug = SlugsWhere<{ kind: "provider"; status: "planned" }>;
/** The slugs that have an integration page. */
export type CatalogSlug = SlugsWhere<{ kind: "provider" }>;
/**
 * Every slug the tool surface can load: a provider or a channel. `system` and
 * `mcp` are excluded; they are Alfred's own machinery, not a connection.
 */
export type LoadableIntegrationSlug = Exclude<IntegrationSlug, InternalIntegrationSlug>;

export type GoogleSlug = SlugsWhere<{ credential: { shape: "google_oauth" } }>;
export type GithubAppSlug = SlugsWhere<{ credential: { shape: "github_app" } }>;
/** The slugs whose access is one long-lived bearer token: the shared bearer persistence layer's domain. */
export type BearerSlug = SlugsWhere<{ credential: { shape: "bearer" } }>;

/**
 * The persisted vocabulary of `integration_credentials.provider` and the route
 * family `/api/integrations/<provider>`: `google` for the Google products, the
 * slug for every other live provider. See `CredentialSpec` in `./types`.
 */
export type CredentialProvider = "google" | GithubAppSlug | BearerSlug;

export type SupportedPassthroughSlug = SlugsWhere<{
  passthrough: { transport: PassthroughTransportKind };
}>;
export type SupportedRestSlug = SlugsWhere<{ passthrough: { transport: "rest" } }>;
export type SupportedGraphqlSlug = SlugsWhere<{ passthrough: { transport: "graphql" } }>;

/** Every `brand` literal a provider entry owns; the web keys its icon table on this. */
export type IntegrationBrandKey = IntegrationEntryOf<CatalogSlug>["brand"];

// ---------------------------------------------------------------------------
// Runtime lists.
// ---------------------------------------------------------------------------

export const LOADABLE_INTEGRATION_SLUGS: readonly LoadableIntegrationSlug[] =
  INTEGRATION_SLUGS.filter(
    (slug): slug is LoadableIntegrationSlug => INTEGRATIONS[slug].kind !== "internal",
  );
export const isLoadableIntegrationSlug = enumGuard(LOADABLE_INTEGRATION_SLUGS);

export const CATALOG_SLUGS: readonly CatalogSlug[] = INTEGRATION_SLUGS.filter(
  (slug): slug is CatalogSlug => INTEGRATIONS[slug].kind === "provider",
);
export const isCatalogSlug = enumGuard(CATALOG_SLUGS);

export const LIVE_PROVIDER_SLUGS: readonly LiveProviderSlug[] = INTEGRATION_SLUGS.filter(
  (slug): slug is LiveProviderSlug => {
    const entry = INTEGRATIONS[slug];
    return entry.kind === "provider" && entry.status === "live";
  },
);
export const isLiveProviderSlug = enumGuard(LIVE_PROVIDER_SLUGS);

export const PLANNED_SLUGS: readonly PlannedSlug[] = INTEGRATION_SLUGS.filter(
  (slug): slug is PlannedSlug => {
    const entry = INTEGRATIONS[slug];
    return entry.kind === "provider" && entry.status === "planned";
  },
);
export const isPlannedSlug = enumGuard(PLANNED_SLUGS);

export const GOOGLE_SLUGS: readonly GoogleSlug[] = LIVE_PROVIDER_SLUGS.filter(
  (slug): slug is GoogleSlug => INTEGRATIONS[slug].credential.shape === "google_oauth",
);
export const isGoogleSlug = enumGuard(GOOGLE_SLUGS);

export const BEARER_PROVIDER_SLUGS: readonly BearerSlug[] = LIVE_PROVIDER_SLUGS.filter(
  (slug): slug is BearerSlug => INTEGRATIONS[slug].credential.shape === "bearer",
);
export const isBearerProvider = enumGuard(BEARER_PROVIDER_SLUGS);

/** The credential provider of a live slug: `google` for a Google product, else the slug itself. */
export function credentialProviderOf(slug: LiveProviderSlug): CredentialProvider {
  return isGoogleSlug(slug) ? "google" : slug;
}

/**
 * The route family of a credential provider, `/api/integrations/<provider>`.
 * The literal type survives so Eden's client keeps a typed path per provider.
 */
export function integrationRoutePrefix<P extends CredentialProvider>(
  provider: P,
): `/api/integrations/${P}` {
  return `/api/integrations/${provider}`;
}

/** The distinct providers, in first-appearance slug order (`google` once for six slugs). */
export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  ...new Set(LIVE_PROVIDER_SLUGS.map(credentialProviderOf)),
];
export const isCredentialProvider = enumGuard(CREDENTIAL_PROVIDERS);

export const SUPPORTED_PASSTHROUGH_SLUGS: readonly SupportedPassthroughSlug[] =
  LIVE_PROVIDER_SLUGS.filter(
    (slug): slug is SupportedPassthroughSlug => INTEGRATIONS[slug].passthrough !== null,
  );
export const isSupportedPassthroughSlug = enumGuard(SUPPORTED_PASSTHROUGH_SLUGS);

export const SUPPORTED_REST_PASSTHROUGH_SLUGS: readonly SupportedRestSlug[] =
  SUPPORTED_PASSTHROUGH_SLUGS.filter(
    (slug): slug is SupportedRestSlug => INTEGRATIONS[slug].passthrough.transport === "rest",
  );
