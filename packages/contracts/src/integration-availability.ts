import { z } from "zod";
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

/**
 * The health of one live integration whose credential provider has rows:
 * `active` when one row satisfies the entry's connected rule, `needs_reauth`
 * when none does. No rows at all is `null` at the use site, not a member. The
 * one owner of the vocabulary: the dispatch snapshot below and the
 * `GET /api/integrations` wire (`./integration-status`) both derive from it.
 */
export const integrationHealthSchema = z.enum(["active", "needs_reauth"]);
export type IntegrationHealth = z.infer<typeof integrationHealthSchema>;

export interface IntegrationAvailability {
  health: IntegrationHealth | null;
  accountLabel: string | null;
}

/**
 * The label a credential row shows for its account: the provider's label,
 * trimmed, or `null` when it gave none or a blank. The one rule the dispatch
 * snapshot, the boss preamble, and the `GET /api/integrations` body share, so a
 * whitespace label cannot read `null` in one place and `"  "` in another.
 */
export function credentialAccountLabel(
  row: Pick<ProviderAvailability, "accountLabel">,
): string | null {
  return row.accountLabel?.trim() || null;
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
