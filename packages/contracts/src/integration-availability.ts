import { z } from "zod";
import type {
  CredentialProofRow,
  CredentialProvider,
  LoadableIntegrationSlug,
  SupportedPassthroughSlug,
} from "./integrations";

/** One `integration_credentials` row, as the availability policy reads it. */
export interface ProviderAvailability extends CredentialProofRow {
  credentialId: string;
  accountId: string;
  status: string;
  scopes: Set<string>;
  installationId: string | null;
  accountLabel: string | null;
  metadata: unknown;
}

/** A tool's own credential need, when it is narrower than its integration's. */
export interface ToolCredentialRequirement {
  provider: CredentialProvider;
  anyOfScopes: readonly string[];
}

/** `needs_reauth` when no row passes the connected rule. No rows at all is `null` at the use site. */
export const integrationHealthSchema = z.enum(["active", "needs_reauth"]);

export type IntegrationHealth = z.infer<typeof integrationHealthSchema>;

export interface IntegrationAvailability {
  health: IntegrationHealth | null;
  accountLabel: string | null;
}

/** Trimmed label, or `null` when blank. */
export function credentialAccountLabel(
  row: Pick<ProviderAvailability, "accountLabel">,
): string | null {
  return row.accountLabel?.trim() || null;
}

/**
 * Rows by provider. A slug that is not a provider, such as `gmail`, fails to compile.
 * Delivery health readers take this map so they reuse the caller's rows.
 */
export type CredentialRowsByProvider = ReadonlyMap<
  CredentialProvider,
  readonly ProviderAvailability[]
>;

export interface IntegrationAvailabilitySnapshot {
  integrations: ReadonlyMap<LoadableIntegrationSlug, IntegrationAvailability>;
  providers: CredentialRowsByProvider;
  /** Off by default. */
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
