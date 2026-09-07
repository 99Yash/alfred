/**
 * The wire shapes of the integration status reads. `GET /api/integrations` is
 * the main one: the registry joined with the
 * user's credentials and resolved through the connected rule (ADR-0093), one
 * read the web renders without a merge of its own. The server owns the join
 * (`readIntegrationStatus` in `@alfred/assistant/connections`); the web parses
 * this schema at its boundary and indexes it by slug.
 *
 * Both halves are keyed, not listed. `integrations` is an exhaustive record
 * over the live slugs: zod 4's enum-keyed `z.record` rejects a body with a slug
 * missing, so a consumer reads `integrations[slug]` with no fallback and the
 * next live slug lands in one registry edit. `providers` is partial: a
 * credential provider is present iff it holds at least one `active` row.
 *
 * Timestamps are ISO strings, not `Date`s: this describes the serialized JSON
 * body, not the database row.
 *
 * `GET /api/integrations/raw-kinds/:slug` (ADR-0097 item 9) is the second read:
 * the raw receipt inventory of one live slug, defined at the end of this file.
 */

import { z } from "zod";
import { integrationHealthSchema } from "./integration-availability";
import { CREDENTIAL_PROVIDERS, LIVE_PROVIDER_SLUGS } from "./integrations";

/** One credential row that proves its integration connected: the disconnect target. */
export const connectedAccountSchema = z.object({
  /** `integration_credentials.id`. */
  id: z.string(),
  /** The row's trimmed label, or its account id when the provider gave none. */
  accountLabel: z.string(),
  connectedAt: z.string(),
  /**
   * Gmail only (#998): the last moment push delivery is known to have worked,
   * set while the poll-fallback sweep keeps finding mail that no push announced.
   * `null` while push is live, while it is unproven, and for every other slug.
   */
  pushStaleSince: z.string().nullable(),
});
export type ConnectedAccount = z.infer<typeof connectedAccountSchema>;

/**
 * One live provider's connection state. `health` is `null` when its credential
 * provider has no row at all, `needs_reauth` when rows exist but none satisfies
 * the entry's connected rule, and `active` when at least one does. `accounts`
 * lists exactly the rows that satisfy it, oldest first.
 */
export const integrationConnectionSchema = z.object({
  health: integrationHealthSchema.nullable(),
  accounts: z.array(connectedAccountSchema),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

/**
 * One `active` row of a credential provider, with the provider's live slugs
 * whose connected rule it fails: the Google products whose scopes the user
 * unchecked on the consent screen, or the `github` slug a classic-OAuth row
 * without an App installation cannot prove. The wire states which rows fail
 * which rules; whether that is worth a banner is the web's reading of it.
 */
export const activeCredentialSchema = z.object({
  accountId: z.string(),
  /** The row's trimmed label, `null` when the provider gave none. */
  accountLabel: z.string().nullable(),
  missing: z.array(z.enum(LIVE_PROVIDER_SLUGS)),
});
export type ActiveCredential = z.infer<typeof activeCredentialSchema>;

export const integrationStatusSchema = z.object({
  /** Every live slug, in registry order. */
  integrations: z.record(z.enum(LIVE_PROVIDER_SLUGS), integrationConnectionSchema),
  /** Each credential provider with at least one `active` row, its active rows oldest first. */
  providers: z.partialRecord(z.enum(CREDENTIAL_PROVIDERS), z.array(activeCredentialSchema)),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

/**
 * One provider kind the event registry does not name, as the raw receipt tier
 * has observed it for this integration (ADR-0097 item 9): how many verified
 * deliveries carried it and when the last one arrived.
 */
export const rawReceiptKindSchema = z.object({
  /** The provider's own kind, verbatim: `comment.created`, `issue_comment.created`. */
  kind: z.string(),
  count: z.number().int().nonnegative(),
  lastSeenAt: z.string(),
});
export type RawReceiptKind = z.infer<typeof rawReceiptKindSchema>;

/** The wire shape of `GET /api/integrations/raw-kinds/:slug`, most recently seen first. */
export const rawReceiptInventorySchema = z.object({
  kinds: z.array(rawReceiptKindSchema),
  embedding: z.object({
    dailyCap: z.number().int().positive(),
    cappedCount: z.number().int().nonnegative(),
  }),
});
export type RawReceiptInventory = z.infer<typeof rawReceiptInventorySchema>;
