import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * State of external work objects, such as GitHub PRs and deploys (ADR-0062).
 * Only the reducer writes state, through `objectStateStore.applyEvents`, from a
 * provider fact (a webhook, a verified pull, or a loop read). An LLM may propose a key but never
 * asserts state, so a made-up key cannot fake a merge (ADR-0048).
 * A briefing reads a short window, so it needs this stored state to see a close.
 */

// ---------------------------------------------------------------------------
// integration_objects
// ---------------------------------------------------------------------------

/** One row per external object. Bitemporal like `user_facts`, but not written by `proposeFact`. */
export const integrationObjects = pgTable(
  "integration_objects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("iobj")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** Scoped by provider, so Railway and Vercel share the deployment kind names. */
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    /** Provider-neutral state that generic readers use. */
    stateCategory: text("state_category").notNull(),
    nativeState: text("native_state"),
    title: text("title"),
    url: text("url"),
    repo: text("repo"),
    attributes: jsonb("attributes")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Guards transitions, so a late or repeated webhook cannot move state back. */
    stateDeliveredAt: timestamp("state_delivered_at", { withTimezone: true }),
    /**
     * Provider time of the held state. Target rows order by this, then `state_delivered_at`.
     * Null when the delta has no provider time (PRs, attempts) or for older rows.
     */
    providerEventAt: timestamp("provider_event_at", { withTimezone: true }),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    supersedesId: text("supersedes_id"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("integration_objects_identity_idx").on(t.userId, t.provider, t.kind, t.externalId),
    index("integration_objects_state_idx").on(t.userId, t.stateCategory),
  ],
);

// ---------------------------------------------------------------------------
// integration_object_keys
// ---------------------------------------------------------------------------

/** Other keys that resolve to an object, such as a `head_sha` or PR URL from mail. */
export const integrationObjectKeys = pgTable(
  "integration_object_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("iobjk")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectId: text("object_id")
      .notNull()
      .references(() => integrationObjects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    keyKind: text("key_kind").notNull(),
    keyValue: text("key_value").notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("integration_object_keys_unique_idx").on(
      t.userId,
      t.provider,
      t.keyKind,
      t.keyValue,
    ),
    index("integration_object_keys_object_idx").on(t.objectId),
  ],
);

// ---------------------------------------------------------------------------
// integration_object_pulls
// ---------------------------------------------------------------------------

/**
 * When the verified pull last chose an object (#1351). Not a column on the object, because a stamp
 * there would move `updated_at`, and every `list` caller orders by it.
 */
export const integrationObjectPulls = pgTable(
  "integration_object_pulls",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("iobjp")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectId: text("object_id")
      .notNull()
      .references(() => integrationObjects.id, { onDelete: "cascade" }),
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull(),
    /**
     * Reads in a row that succeeded and found no readable attempt for the object. A fault does not
     * count, a read that proves a state clears it, and a push since the last pick restarts it.
     */
    absentReads: integer("absent_reads").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [uniqueIndex("integration_object_pulls_object_idx").on(t.objectId)],
);

// ---------------------------------------------------------------------------
// loop_verification_runs
// ---------------------------------------------------------------------------

/**
 * One row for each `verifyLoops` run that committed (ADR-0120 decision 7). The same transaction
 * folds the facts of the run, so a row exists only when every fact of the run is stored. The next
 * run starts its window at the newest `ran_at`, or at its `oldest_unverified_mail_at` when that is
 * older (decision 4). A run inserts its row one time and never updates it.
 */
export const loopVerificationRuns = pgTable(
  "loop_verification_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("lvr")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    /** Things in the verify set, live reads, and facts folded. For a reader of the run history. */
    thingCount: integer("thing_count").notNull(),
    liveReadCount: integer("live_read_count").notNull(),
    factCount: integer("fact_count").notNull(),
    /** Things that no read of the run backs: no reader, no target, over the cap, or a failed read. */
    unverifiedCount: integer("unverified_count").notNull(),
    /**
     * The oldest mail of a thing in `unverified_count`. `NULL` when no such thing has a mail. The
     * next window starts at or before it, so the thing stays in the set.
     */
    oldestUnverifiedMailAt: timestamp("oldest_unverified_mail_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("loop_verification_runs_user_ran_idx").on(t.userId, t.ranAt)],
);

export type LoopVerificationRun = typeof loopVerificationRuns.$inferSelect;

export type NewLoopVerificationRun = typeof loopVerificationRuns.$inferInsert;

export type IntegrationObject = typeof integrationObjects.$inferSelect;

export type NewIntegrationObject = typeof integrationObjects.$inferInsert;

export type IntegrationObjectKey = typeof integrationObjectKeys.$inferSelect;

export type IntegrationObjectPull = typeof integrationObjectPulls.$inferSelect;
