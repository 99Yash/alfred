/**
 * Wire shapes for `GET /api/integrations` (ADR-0093) and `GET /api/integrations/raw-kinds/:slug`.
 * `integrations` has every live slug, so readers need no fallback. Timestamps are ISO strings.
 */

import { z } from "zod";
import { integrationHealthSchema } from "./integration-availability";
import { CREDENTIAL_PROVIDERS, LIVE_PROVIDER_SLUGS } from "./integrations";

/** One credential row that proves its integration connected: the disconnect target. */
export const connectedAccountSchema = z.object({
  id: z.string(),
  /** The row's trimmed label, or its account id when the provider gave none. */
  accountLabel: z.string(),
  connectedAt: z.string(),
  /** Gmail only: the poll found mail that push did not deliver. `null` does not prove push works. */
  pushStale: z
    .object({
      since: z.iso.datetime(),
      baseline: z.enum(["push-received", "watch-installed"]),
    })
    .nullable(),
});

export type ConnectedAccount = z.infer<typeof connectedAccountSchema>;

/**
 * `health`: `null` with no row, `needs_reauth` when no row passes the connected rule, else `active`.
 * `accounts` holds the passing rows, oldest first.
 */
export const integrationConnectionSchema = z.object({
  health: integrationHealthSchema.nullable(),
  accounts: z.array(connectedAccountSchema),
});

export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

/**
 * An `active` credential row and the live slugs whose connected rule it fails,
 * for example Google scopes the user unchecked.
 */
export const activeCredentialSchema = z.object({
  accountId: z.string(),
  /** The row's trimmed label, `null` when the provider gave none. */
  accountLabel: z.string().nullable(),
  missing: z.array(z.enum(LIVE_PROVIDER_SLUGS)),
});

export type ActiveCredential = z.infer<typeof activeCredentialSchema>;

/**
 * A connected integration whose deliveries stopped (ADR-0100). A silent source cannot
 * report itself, so the server checks. Listed only when the user can fix it here.
 */
export const deliveryAlertSchema = z.object({
  /** The integration to reconnect. An integration slug, not an event source (ADR-0097). */
  integration: z.enum(LIVE_PROVIDER_SLUGS),
  /** The sentence from the source's health check. */
  reason: z.string().min(1).max(200),
});

export type DeliveryAlert = z.infer<typeof deliveryAlertSchema>;

export const integrationStatusSchema = z.object({
  integrations: z.record(z.enum(LIVE_PROVIDER_SLUGS), integrationConnectionSchema),
  /** Only providers with an `active` row. Rows oldest first. */
  providers: z.partialRecord(z.enum(CREDENTIAL_PROVIDERS), z.array(activeCredentialSchema)),
  /** Defaults to empty so a new web bundle can parse an old server's response. */
  deliveryAlerts: z.array(deliveryAlertSchema).default([]),
});

export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

/** A provider kind the event registry does not name, as seen in raw receipts (ADR-0097). */
export const rawReceiptKindSchema = z.object({
  /** Verbatim, for example `issue_comment.created`. */
  kind: z.string(),
  count: z.number().int().nonnegative(),
  lastSeenAt: z.string(),
});

export type RawReceiptKind = z.infer<typeof rawReceiptKindSchema>;

/** `kinds` is most recently seen first. */
export const rawReceiptInventorySchema = z.object({
  kinds: z.array(rawReceiptKindSchema),
  embedding: z.object({
    dailyCap: z.number().int().positive(),
    cappedCount: z.number().int().nonnegative(),
  }),
});

export type RawReceiptInventory = z.infer<typeof rawReceiptInventorySchema>;
