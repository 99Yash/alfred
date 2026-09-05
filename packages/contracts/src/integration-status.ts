/**
 * The wire shape of `GET /api/integrations`: the registry joined with the
 * user's credentials and resolved through the connected rule (ADR-0093), one
 * read the web renders without a merge of its own. The server owns the join
 * (`readIntegrationStatus` in `@alfred/assistant/connections`); the web parses
 * this schema at its boundary and looks entries up by slug.
 *
 * Timestamps are ISO strings, not `Date`s: this describes the serialized JSON
 * body, not the database row.
 */

import { z } from "zod";
import { CREDENTIAL_PROVIDERS, LIVE_PROVIDER_SLUGS } from "./integrations";

export const integrationHealthSchema = z.enum(["active", "needs_reauth"]);

/** One credential row that proves its integration connected: the disconnect target. */
export const connectedAccountSchema = z.object({
  /** `integration_credentials.id`. */
  id: z.string(),
  /** The row's label, or its account id when the provider gave none. */
  accountLabel: z.string(),
  connectedAt: z.string(),
});
export type ConnectedAccount = z.infer<typeof connectedAccountSchema>;

/**
 * One live provider's connection state. `health` is `null` when its credential
 * provider has no row at all, `needs_reauth` when rows exist but none satisfies
 * the entry's connected rule, and `active` when at least one does. `accounts`
 * lists exactly the rows that satisfy it.
 */
export const integrationConnectionSchema = z.object({
  slug: z.enum(LIVE_PROVIDER_SLUGS),
  health: integrationHealthSchema.nullable(),
  accounts: z.array(connectedAccountSchema),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

/**
 * One credential provider that has at least one `active` row. The row can still
 * fail an integration's connected rule (a Google grant with unchecked scopes, a
 * classic-OAuth GitHub row with no App installation), and `missing` names the
 * provider's live slugs that no active row proves. The web's "connected but
 * incomplete" banners read this list; an empty list is nothing to nag about.
 */
export const providerCredentialStateSchema = z.object({
  provider: z.enum(CREDENTIAL_PROVIDERS),
  /** The first active row's account id. */
  accountId: z.string(),
  /** The first active row's label, `null` when the provider gave none. */
  accountLabel: z.string().nullable(),
  missing: z.array(z.enum(LIVE_PROVIDER_SLUGS)),
});
export type ProviderCredentialState = z.infer<typeof providerCredentialStateSchema>;

export const integrationStatusSchema = z.object({
  /** One entry per live provider, in registry order. */
  integrations: z.array(integrationConnectionSchema),
  /** One entry per credential provider with an active row, in registry order. */
  providers: z.array(providerCredentialStateSchema),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
