/** The integration registry (ADR-0093). The keys of `INTEGRATIONS` are the slug space. */

export {
  type CredentialSpec,
  type PassthroughTransportKind,
  INTEGRATIONS,
  type IntegrationSlug,
  INTEGRATION_SLUGS,
  isIntegrationSlug,
  integrationEntry,
} from "./registry";

export {
  type LiveProviderSlug,
  type CatalogSlug,
  type LoadableIntegrationSlug,
  type GoogleSlug,
  type BearerSlug,
  type CredentialProvider,
  type SupportedPassthroughSlug,
  type SupportedRestSlug,
  type IntegrationBrandKey,
  LOADABLE_INTEGRATION_SLUGS,
  isLoadableIntegrationSlug,
  CATALOG_SLUGS,
  isCatalogSlug,
  LIVE_PROVIDER_SLUGS,
  isLiveProviderSlug,
  isPlannedSlug,
  GOOGLE_SLUGS,
  isGoogleSlug,
  credentialProviderOf,
  integrationRoutePrefix,
  integrationConnectPath,
  CREDENTIAL_PROVIDERS,
  isCredentialProvider,
  SUPPORTED_PASSTHROUGH_SLUGS,
  isSupportedPassthroughSlug,
  SUPPORTED_REST_PASSTHROUGH_SLUGS,
} from "./slugs";

export { INTEGRATION_ACTIONS, INTEGRATION_DISPLAY_NAMES, LIVE_PROVIDERS } from "./projections";

export {
  CREDENTIAL_STATUSES,
  type CredentialStatus,
  type CredentialProofRow,
  holdsAnyScope,
  credentialSatisfies,
  selectGithubAccountRow,
} from "./connected";

export { type GoogleAuthority, googleAuthorityScopes } from "./google-authority";
