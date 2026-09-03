import {
  CREDENTIAL_PROVIDERS,
  type AccountPersona,
  type CredentialProvider,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { SealedCredentialSecret } from "../credential-vault";
import { createId, inList, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Per-user OAuth credentials for external providers (Gmail/Calendar today,
 * Slack/Linear/etc. later). Deliberately kept separate from Better Auth's
 * `account` table — Better Auth manages the user's *identity* (sign-in
 * provider tokens), while this table manages *capability* tokens for
 * services alfred reads/writes on the user's behalf.
 *
 * Why separate:
 *  - Token-refresh policy differs (offline-access scopes, long-lived
 *    refresh tokens, per-provider quirks).
 *  - One user can connect multiple accounts of the same provider
 *    (work + personal Gmail), keyed by `account_id` (the provider's
 *    own user identifier — Google `sub`, Slack workspace+user, etc.).
 *  - Scopes evolve independently of identity scopes.
 *
 * `access_token` and `refresh_token` hold an authenticated AES-256-GCM
 * envelope, never a usable token (#453, ADR-0038 as amended). The columns stay
 * `text` because the envelope is self-describing — version, algorithm, key id,
 * nonces, and tags all live inside the stored string, so nonce and tag columns
 * would add migration surface without adding validation.
 *
 * `@alfred/db/credential-vault` owns that representation, and the three
 * persistence modules in `@alfred/integrations` (Google, GitHub, shared bearer)
 * are the only writers. Both columns are typed {@link SealedCredentialSecret},
 * which is nominal in both directions: a plaintext write does not compile,
 * because the brand is only mintable by `credentialVault().seal`, and a
 * persisted value cannot reach a provider header, a template literal, or any
 * `string` parameter without `credentialVault().open` first. A test that
 * deliberately seeds the pre-#453 plaintext shape casts, and says so at the
 * cast.
 *
 * Better Auth's `account` table cannot have the same guard: its adapter hands
 * the driver a loosely typed payload, so nothing there would typecheck against
 * a branded column. That side is enforced at runtime instead, by the
 * `encryptedAuthAdapter` decorator plus the boot gate. The asymmetry is
 * deliberate: type-level where a writer exists to type, runtime where one does
 * not.
 *
 * Why credentials and not content: a leaked row here is not a disclosure, it is
 * a transferable capability. Railway workspace tokens in particular CANNOT be
 * scoped down — one is full workspace write and can redeploy any service in a
 * shared team.
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
     * The credential provider (ADR-0093): `google` for every Google product,
     * else the live provider's slug (`github`, `notion`, `railway`, `vercel`).
     * The vocabulary is derived from the integration registry, and the CHECK
     * below holds the column to it, so a new provider is a migration.
     */
    provider: text("provider").$type<CredentialProvider>().notNull(),
    /** Provider-side user identifier — Google `sub`, Slack `team:user`, etc. */
    accountId: text("account_id").notNull(),
    /** Email or display label surfaced in the UI ("dev.7@oliv.ai"). */
    accountLabel: text("account_label"),
    accessToken: text("access_token").$type<SealedCredentialSecret>().notNull(),
    refreshToken: text("refresh_token").$type<SealedCredentialSecret>(),
    tokenType: text("token_type").default("Bearer"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Granted scopes parsed into an array — providers vary on space vs comma separation. */
    scopes: jsonb("scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Free-form provider-specific bag: id_token claims, raw refresh response, watch-channel ids, etc. */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * GitHub App installation id (ADR-0052). NULL for every other provider
     * and for legacy classic-OAuth GitHub rows. Inbound webhooks carry only
     * `installation.id`, so this is the join key from a delivery back to the
     * owning user; the indexed lookup lives in `webhook_events` resolution.
     */
    installationId: text("installation_id"),
    status: text("status").notNull().default("active"),
    /**
     * Account persona (ADR-0051, triage v3): `'work' | 'personal'`. Auto-detected
     * from the Google `hd` (hosted-domain) claim at connect — a Workspace domain
     * means `work`, its absence means `personal` — and user-overridable. Fed to
     * the triage classifier as a one-line context hint. NULL until detected
     * (legacy rows predating the column). The rich persona *policy* (what is
     * work-urgent vs personal-urgent) is a deferred future ADR; v1 is label +
     * plumbing only.
     */
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
    // Webhook deliveries resolve their owning user by GitHub installation id.
    index("integration_credentials_installation_idx").on(t.installationId),
  ],
);

/**
 * Per-(integration, sync-stream) cursor. Stores whatever the provider's
 * delta API needs as a continuation token — Gmail `historyId`, Slack
 * `cursor`, Calendar `syncToken`, GitHub `etag` etc. Kept generic via
 * `state` jsonb so each ingestor owns the shape.
 *
 *  - `last_sync_at` and `last_full_sync_at` distinguish incremental
 *    pulls from full re-ingestion (used after a watch-channel expiry
 *    or a token rotation that invalidates the cursor).
 *  - `stream` discriminates multiple sync streams under one credential
 *    ("messages" vs "labels" vs "drafts" — we'll only use "messages"
 *    initially but the column lets us add streams without migrations).
 */
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
    lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("ingestion_state_unique_idx").on(t.credentialId, t.stream),
    index("ingestion_state_user_idx").on(t.userId, t.provider),
  ],
);

/**
 * Inbound provider webhook deliveries (ADR-0024 / ADR-0052). v1 carries
 * GitHub App activity — `pull_request`, `push`, `issues`,
 * `pull_request_review` — but the shape is provider-generic so other push
 * sources can land here later.
 *
 * Idempotency is the whole point: GitHub redelivers on any non-2xx and on
 * manual replay, so the receiver inserts `on conflict do nothing` keyed by
 * `(provider, provider_event_id)` — the `X-GitHub-Delivery` UUID — and a
 * duplicate is a no-op rather than a double-counted activity item. This
 * matches the replay-safe story in ADR-0014.
 *
 * The raw `payload` is retained so the briefing's `integration_activity`
 * contributor (and future surfaces) can re-derive richer detail without a
 * schema change; `event_type`/`action`/`repo` are denormalized out for
 * cheap filtering and rollup.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("whe")),
    /** 'github' today; matches `integration_credentials.provider`. */
    provider: text("provider").notNull(),
    /** Provider-side unique delivery id — GitHub's `X-GitHub-Delivery` UUID. */
    providerEventId: text("provider_event_id").notNull(),
    /** GitHub `X-GitHub-Event` header: 'pull_request', 'push', 'issues', … */
    eventType: text("event_type").notNull(),
    /** Payload `action` when present ('opened', 'closed', 'merged', …); NULL for events like `push`. */
    action: text("action"),
    /** Affected repo full name ('owner/repo') when the payload carries one. */
    repo: text("repo"),
    /** GitHub App installation id the delivery came from — the join key to the owning user. */
    installationId: text("installation_id"),
    /**
     * Owning user, resolved from `installation_id` at receive time. Nullable:
     * a delivery for an installation we can't map (e.g. mid-uninstall) is
     * still persisted for audit rather than dropped.
     */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** Full webhook body, retained for re-derivation. */
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** When GitHub says it delivered (header timestamp) — defaults to receipt time. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("webhook_events_dedup_idx").on(t.provider, t.providerEventId),
    index("webhook_events_user_provider_idx").on(t.userId, t.provider, t.deliveredAt),
  ],
);

/**
 * Durable event receipts for the trigger readiness control plane (#560).
 * Each row is one provider delivery — one Pub/Sub push, one GitHub webhook,
 * etc. — deduplicated by `(provider, provider_delivery_id)`. The table is
 * the audit trail for "did we receive this?" and the source of truth for
 * gap detection (the `coverageGap` / `lastVerifiedDelivery` signals that
 * workflow readiness reads).
 *
 * Gmail v1: `provider_delivery_id` is the Pub/Sub `message.messageId`, which
 * is stable across redeliveries. `event_type` is `gmail.message_received`.
 * `verification_result` records the OIDC outcome ('oidc_valid', 'oidc_skipped',
 * or 'oidc_failed'). `processing_status` tracks whether the ingestion job ran
 * and completed.
 *
 * The full unique index on `(provider, provider_delivery_id)` deduplicates
 * redeliveries at the DB level. The webhook handler uses `onConflictDoNothing`
 * so a duplicate insert is a no-op. Failed deliveries are not retried with a
 * new row — the index prevents duplicate receipts for the same delivery.
 */
export const eventReceipts = pgTable(
  "event_receipts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("evr")),
    /** 'google' for Gmail; 'github', 'slack', etc. later. */
    provider: text("provider").notNull(),
    /** Pub/Sub messageId (Gmail) or X-GitHub-Delivery (GitHub). Stable across redeliveries. */
    providerDeliveryId: text("provider_delivery_id").notNull(),
    /** FK to integration_credentials — the account that owns this delivery. */
    credentialId: text("credential_id")
      .notNull()
      .references(() => integrationCredentials.id, { onDelete: "cascade" }),
    /** Owning user, resolved from the credential at receive time. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Event kind: 'gmail.message_received' for Gmail v1. */
    eventType: text("event_type").notNull(),
    /** Gmail historyId from the push notification (presence gate + cursor). */
    historyId: text("history_id"),
    /** OIDC verification outcome: 'oidc_valid', 'oidc_skipped' (dev), 'oidc_failed'. */
    verificationResult: text("verification_result").notNull().default("oidc_valid"),
    /** SHA-256 hex of the raw Pub/Sub body for audit / re-derivation. */
    payloadHash: text("payload_hash"),
    /**
     * Processing state: 'pending' (received, not yet ingested), 'completed'
     * (ingestion job ran), 'failed' (ingestion job errored).
     */
    processingStatus: text("processing_status").notNull().default("pending"),
    /** When the provider delivered (Pub/Sub push timestamp). Defaults to DB receive time. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the ingestion job completed or failed. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("event_receipts_dedup_idx").on(t.provider, t.providerDeliveryId),
    index("event_receipts_credential_idx").on(t.credentialId, t.deliveredAt),
    index("event_receipts_user_idx").on(t.userId, t.provider, t.deliveredAt),
  ],
);

export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type IngestionState = typeof ingestionState.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type EventReceipt = typeof eventReceipts.$inferSelect;
