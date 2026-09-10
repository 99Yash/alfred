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
   * Gmail only: evidence that fallback found mail with no recent push delivery.
   * The baseline distinguishes an actual receipt from a watch installation.
   * `null` means no stale evidence; it does not prove successful push processing.
   */
  pushStale: z
    .object({
      since: z.iso.datetime(),
      baseline: z.enum(["push-received", "watch-installed"]),
    })
    .nullable(),
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

/**
 * One integration whose event deliveries stopped for a user who connected it
 * (ADR-0100). A source that only produces deliveries while it is healthy cannot
 * report its own silence, so the server pulls the verdict and puts it here,
 * beside the connect state the same read already carries.
 *
 * Two rules bound the list, and both are applied server-side:
 *
 * 1. The user connected this integration and delivery has since stopped. A
 *    source nobody connected is not on this list, and neither is one Alfred
 *    holds no health signal for.
 * 2. The one recovery is an action the user can take here. A verdict only an
 *    operator or the passage of time can clear is logged, never printed.
 *
 * The wire carries slugs and one sentence, never display copy and never a URL.
 * The web already owns the display name and the integration route, so it
 * resolves both at render time; a stored or transmitted label would freeze
 * today's wording into tomorrow's page.
 */
export const deliveryAlertSchema = z.object({
  /**
   * The integration whose connect flow restores deliveries. This is the
   * recovery's own integration slug, not the event source's: the two are
   * different spaces that only happen to collide today (ADR-0097).
   */
  integration: z.enum(LIVE_PROVIDER_SLUGS),
  /** The one sentence the source's own health check gave, for the banner's body. */
  reason: z.string().min(1).max(200),
});
export type DeliveryAlert = z.infer<typeof deliveryAlertSchema>;

export const integrationStatusSchema = z.object({
  /** Every live slug, in registry order. */
  integrations: z.record(z.enum(LIVE_PROVIDER_SLUGS), integrationConnectionSchema),
  /** Each credential provider with at least one `active` row, its active rows oldest first. */
  providers: z.partialRecord(z.enum(CREDENTIAL_PROVIDERS), z.array(activeCredentialSchema)),
  /**
   * Integrations that stopped delivering, at most one entry per integration.
   * Empty on a healthy account, which is the ordinary case.
   *
   * The default is what makes this field safe to deploy: a browser holding the
   * new bundle against a server that has not restarted yet reads an absent key
   * as an empty list, instead of failing the parse and reporting every
   * integration as disconnected.
   */
  deliveryAlerts: z.array(deliveryAlertSchema).default([]),
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
