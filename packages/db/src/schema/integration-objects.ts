import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { entities } from "./memory";

/**
 * State of external work objects, such as GitHub PRs and deploys (ADR-0062).
 * Only the webhook reducer writes state. An LLM may propose a key but never
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
// integration_object_relations
// ---------------------------------------------------------------------------

/** Object to entity edges. Objects change often, so they do not become `entities` rows. */
export const integrationObjectRelations = pgTable(
  "integration_object_relations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("iobjr")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectId: text("object_id")
      .notNull()
      .references(() => integrationObjects.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("integration_object_relations_unique_idx").on(
      t.userId,
      t.objectId,
      t.entityId,
      t.relation,
    ),
    index("integration_object_relations_entity_idx").on(t.userId, t.entityId),
  ],
);

export type IntegrationObject = typeof integrationObjects.$inferSelect;

export type NewIntegrationObject = typeof integrationObjects.$inferInsert;

export type IntegrationObjectKey = typeof integrationObjectKeys.$inferSelect;

export type IntegrationObjectRelation = typeof integrationObjectRelations.$inferSelect;
