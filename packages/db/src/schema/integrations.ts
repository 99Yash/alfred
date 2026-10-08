import {
  CREDENTIAL_PROVIDERS,
  type AccountPersona,
  type CredentialProvider,
  type JsonObject,
} from "@alfred/contracts";
import { getTableColumns, isNull, sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  pgView,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { SealedCredentialSecret } from "../credential-vault";
import { createId, inList, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Per-user capability tokens for external providers. Better Auth's `account`
 * holds sign-in identity; this holds what Alfred uses to act for the user.
 * Both token columns hold a sealed AES-256-GCM envelope (ADR-0038), never a usable token.
 * The {@link SealedCredentialSecret} brand blocks a plaintext write and a raw read.
 */
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("intc")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * `google` for every Google product, else the live provider slug (ADR-0093).
     * A new provider needs a migration for the CHECK.
     */
    provider: text("provider").$type<CredentialProvider>().notNull(),
    /** Provider-side user id, e.g. Google `sub`. */
    accountId: text("account_id").notNull(),
    accountLabel: text("account_label"),
    accessToken: text("access_token").$type<SealedCredentialSecret>().notNull(),
    refreshToken: text("refresh_token").$type<SealedCredentialSecret>(),
    tokenType: text("token_type").default("Bearer"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Parsed into an array because providers split scopes with spaces or commas. */
    scopes: jsonb("scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * The installation id a webhook delivery names. A delivery carries only this id.
     * Always look it up with `provider` too, because each provider owns its id space.
     */
    installationId: text("installation_id"),
    status: text("status").notNull().default("active"),
    /** Detected from the Google `hd` claim at connect; the user can override it (ADR-0051). */
    persona: text("persona").$type<AccountPersona>(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    check(
      "integration_credentials_provider_valid",
      sql`${t.provider} IN (${inList(CREDENTIAL_PROVIDERS)})`,
    ),
    uniqueIndex("integration_credentials_unique_idx").on(t.userId, t.provider, t.accountId),
    index("integration_credentials_installation_idx").on(t.installationId),
  ],
);

/** Sync cursor per (credential, stream). Each ingestor owns the shape of `state`. */
export const ingestionState = pgTable(
  "ingestion_state",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ings")),
    credentialId: text("credential_id")
      .notNull()
      .references(() => integrationCredentials.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    stream: text("stream").notNull().default("messages"),
    state: jsonb("state")
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** Webhook fetch and persist finished. Embedding and triage are not part of it. */
    lastWebhookSyncAt: timestamp("last_webhook_sync_at", { withTimezone: true }),
    lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
    /** Start of the latest poll that inserted mail no push receipt covered. Spots a stale push. */
    lastFallbackInsertAt: timestamp("last_fallback_insert_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("ingestion_state_unique_idx").on(t.credentialId, t.stream),
    index("ingestion_state_user_idx").on(t.userId, t.provider),
  ],
);

/**
 * One row per provider delivery, deduplicated by `(provider, provider_delivery_id)`.
 * The source of truth for gap detection (ADR-0090).
 * A raw receipt (ADR-0097) is a verified delivery of a kind no entry names:
 * `raw_kind` is set and `event_type` is `<slug>.raw`. Typed readers use `typedEventReceipts`.
 */
// Append-only: a trigger rejects a direct DELETE (migration 0134).
// Only the user or credential cascade deletes rows.
// Retention sets only `payload` to NULL. The dedup key, `history_id`, and `delivered_at` stay.
export const eventReceipts = pgTable(
  "event_receipts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("evr")),
    /** `google` for Gmail, else the webhook source slug. */
    provider: text("provider").notNull(),
    /** Pub/Sub messageId or the source's dedup key. Stable across redeliveries. */
    providerDeliveryId: text("provider_delivery_id").notNull(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => integrationCredentials.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** `<source>.<type>`, or `<source>.raw` for a raw receipt. */
    eventType: text("event_type").notNull(),
    /** The provider's own kind, verbatim, on a raw receipt. NULL means typed. */
    rawKind: text("raw_kind"),
    /** Gmail historyId from the push. */
    historyId: text("history_id"),
    /**
     * Gmail: `oidc_valid`, `oidc_skipped` (dev), or `oidc_failed`.
     * Webhooks: always `signature_valid`, because an unverified body is never stored.
     */
    verificationResult: text("verification_result").notNull().default("oidc_valid"),
    /** SHA-256 hex of the raw body. */
    payloadHash: text("payload_hash"),
    /** Verified webhook body. NULL for Gmail and after retention, so NULL does not mean Gmail. */
    payload: jsonb("payload"),
    processingStatus: text("processing_status")
      .$type<"pending" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    /** Defaults to DB receive time. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    check(
      "event_receipts_raw_type_check",
      sql`(${t.rawKind} IS NULL) = (${t.eventType} NOT LIKE '%.raw')`,
    ),
    uniqueIndex("event_receipts_dedup_idx").on(t.provider, t.providerDeliveryId),
    index("event_receipts_credential_idx").on(t.credentialId, t.deliveredAt),
    index("event_receipts_user_idx").on(t.userId, t.provider, t.deliveredAt),
    // Partial, so the retention reaper scans only live bodies, not the whole table.
    index("event_receipts_payload_live_idx")
      .on(t.deliveredAt)
      .where(sql`${t.payload} IS NOT NULL`),
  ],
);

/** Typed consumers read this view so raw traffic cannot consume a query's LIMIT. */
export const typedEventReceipts = pgView("typed_event_receipts").as((qb) => {
  const { rawKind, ...columns } = getTableColumns(eventReceipts);

  return qb.select(columns).from(eventReceipts).where(isNull(rawKind));
});

export type IntegrationCredential = typeof integrationCredentials.$inferSelect;

export type IngestionState = typeof ingestionState.$inferSelect;

export type EventReceipt = typeof eventReceipts.$inferSelect;

export type NewEventReceipt = typeof eventReceipts.$inferInsert;
