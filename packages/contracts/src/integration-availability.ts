import type {
  CredentialProvider,
  LoadableIntegrationSlug,
  SupportedPassthroughSlug,
} from "./integrations";

export interface ProviderAvailability {
  credentialId: string;
  accountId: string;
  status: string;
  scopes: Set<string>;
  accountLabel: string | null;
  metadata: Record<string, unknown>;
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
