import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
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
 * Tokens are stored plaintext for now. Encryption-at-rest is a TODO that
 * lands when we move past single-user — Postgres column encryption with a
 * KMS-derived key is the cleanest path; not blocking v1.
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
    /** 'google', 'slack', 'linear', 'github', 'notion'. */
    provider: text("provider").notNull(),
    /** Provider-side user identifier — Google `sub`, Slack `team:user`, etc. */
    accountId: text("account_id").notNull(),
    /** Email or display label surfaced in the UI ("dev.7@oliv.ai"). */
    accountLabel: text("account_label"),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    tokenType: text("token_type").default("Bearer"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Granted scopes parsed into an array — providers vary on space vs comma separation. */
    scopes: jsonb("scopes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Free-form provider-specific bag: id_token claims, raw refresh response, watch-channel ids, etc. */
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    persona: text("persona"),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("integration_credentials_unique_idx").on(t.userId, t.provider, t.accountId),
    index("integration_credentials_user_idx").on(t.userId, t.provider),
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
