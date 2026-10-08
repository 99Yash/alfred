/** Slug unions and lists, all derived from the registry. Never hand-list a slug tuple. */

import { enumGuard } from "../guards";
import {
  INTEGRATION_SLUGS,
  INTEGRATIONS,
  type IntegrationEntryOf,
  type IntegrationSlug,
} from "./registry";
import type { PassthroughTransportKind } from "./registry";

/** The slugs whose entry extends `P`. */
export type SlugsWhere<P> = {
  [K in IntegrationSlug]: IntegrationEntryOf<K> extends P ? K : never;
}[IntegrationSlug];

export type InternalIntegrationSlug = SlugsWhere<{ kind: "internal" }>;

export type ChannelIntegrationSlug = SlugsWhere<{ kind: "channel" }>;

export type LiveProviderSlug = SlugsWhere<{ kind: "provider"; status: "live" }>;

export type PlannedSlug = SlugsWhere<{ kind: "provider"; status: "planned" }>;

/** Slugs with an integration page. */
export type CatalogSlug = SlugsWhere<{ kind: "provider" }>;

/** Providers and channels. Internal slugs are not connections. */
export type LoadableIntegrationSlug = Exclude<IntegrationSlug, InternalIntegrationSlug>;

export type GoogleSlug = SlugsWhere<{ credential: { shape: "google_oauth" } }>;

export type GithubAppSlug = SlugsWhere<{ credential: { shape: "github_app" } }>;

/** Slugs whose access is one long-lived bearer token. */
export type BearerSlug = SlugsWhere<{ credential: { shape: "bearer" } }>;

/** Bearer slugs where the user pastes the token into a form. */
export type TokenPasteSlug = SlugsWhere<{
  credential: { shape: "bearer"; connect: "token_paste" };
}>;

/** Values of `integration_credentials.provider`: `google` for all Google products, else the slug. */
export type CredentialProvider = "google" | GithubAppSlug | BearerSlug;

export type SupportedPassthroughSlug = SlugsWhere<{
  passthrough: { transport: PassthroughTransportKind };
}>;

export type SupportedRestSlug = SlugsWhere<{ passthrough: { transport: "rest" } }>;

export type SupportedGraphqlSlug = SlugsWhere<{ passthrough: { transport: "graphql" } }>;

/** The web keys its icon table on this. */
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

export const TOKEN_PASTE_SLUGS: readonly TokenPasteSlug[] = BEARER_PROVIDER_SLUGS.filter(
  (slug): slug is TokenPasteSlug => INTEGRATIONS[slug].credential.connect === "token_paste",
);

export const isTokenPasteSlug = enumGuard(TOKEN_PASTE_SLUGS);

export function credentialProviderOf(slug: LiveProviderSlug): CredentialProvider {
  return isGoogleSlug(slug) ? "google" : slug;
}

/** Returns a literal type, so Eden keeps a typed path per provider. */
export function integrationRoutePrefix<P extends CredentialProvider>(
  provider: P,
): `/api/integrations/${P}` {
  return `/api/integrations/${provider}`;
}

/** Distinct providers in slug order. `google` appears once. */
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
