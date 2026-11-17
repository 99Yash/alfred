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
  scopes: Set<string>;
  installationId: string | null;
  accountLabel: string | null;
  metadata: unknown;
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
  /**
   * ADR-0124: chat reads through `system.code_run`. Off when absent or false. Only the
   * `CODE_MODE_READ_PATH_FEATURE_KEY` preference turns it on.
   */
  codeModeReadPath?: boolean;
}

/** Hidden per-user key for the ADR-0124 flip. A missing row means off. No settings UI. */
export const CODE_MODE_READ_PATH_FEATURE_KEY = "feature.internal.code_mode_read_path";

export const TOOL_UNAVAILABILITY_CODES = [
  "not_allowed",
  "wrong_caller",
  "requires_thread",
  "not_connected",
  "needs_reauth",
  "missing_scope",
  "feature_disabled",
] as const;

export type ToolUnavailabilityCode = (typeof TOOL_UNAVAILABILITY_CODES)[number];

export type ToolAvailabilityResult =
  | { available: true }
  | { available: false; code: ToolUnavailabilityCode; reason: string };
