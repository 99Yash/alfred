import type {
  CredentialProofRow,
  CredentialProvider,
  LoadableIntegrationSlug,
  SupportedPassthroughSlug,
} from "./integrations";

/** One `integration_credentials` row as the availability policy reads it; a {@link CredentialProofRow}. */
export interface ProviderAvailability extends CredentialProofRow {
  credentialId: string;
  accountId: string;
  status: string;
  scopes: Set<string>;
  installationId: string | null;
  accountLabel: string | null;
  metadata: Record<string, unknown>;
}

/**
 * The credential a single tool needs when it is narrower than its integration:
 * the provider whose rows to read and the scopes any one of them must hold.
 */
export interface ToolCredentialRequirement {
  provider: CredentialProvider;
  anyOfScopes: readonly string[];
}

export interface IntegrationAvailability {
  health: "active" | "needs_reauth" | null;
  accountLabel: string | null;
}

/** Connection state consumed by tool availability policy. */
export interface IntegrationAvailabilitySnapshot {
  integrations: ReadonlyMap<LoadableIntegrationSlug, IntegrationAvailability>;
  /**
   * Credential rows grouped by `integration_credentials.provider`. The key is
   * the persisted vocabulary the registry derives, so a lookup with a slug that
   * is not a provider (`gmail`, `slack`) is a compile error, not an empty list.
   */
  providers: ReadonlyMap<CredentialProvider, readonly ProviderAvailability[]>;
  /** Default-off general-passthrough enablement for every supported slug. */
  passthroughEnabled: ReadonlyMap<SupportedPassthroughSlug, boolean>;
}

export type ToolUnavailabilityCode =
  | "not_allowed"
  | "wrong_caller"
  | "requires_thread"
  | "not_connected"
  | "needs_reauth"
  | "missing_scope"
  | "feature_disabled";

export type ToolAvailabilityResult =
  | { available: true }
  | { available: false; code: ToolUnavailabilityCode; reason: string };
