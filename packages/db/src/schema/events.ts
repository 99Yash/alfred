import { sql } from "drizzle-orm";
import { bigserial, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * Transactional outbox for realtime user events.
 * Insert in the same transaction as the domain write.
 * `packages/assistant/src/realtime/outbox-relay.ts` publishes to Redis and stamps `published_at`.
 * SSE clients replay with `id > Last-Event-ID`.
 * Replicache pokes do not use this table. The reaper never deletes an unpublished row.
 */
export const eventsOutbox = pgTable(
  "events_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("events_outbox_user_id_idx").on(t.userId, t.id),
    index("events_outbox_unpublished_idx")
      .on(t.id)
      .where(sql`${t.publishedAt} IS NULL`),
    // The reaper pages `published_at < cutoff ORDER BY id LIMIT batch`; walking
    // this partial index in id order needs no sort and stops at the batch size.
    index("events_outbox_published_idx")
      .on(t.id)
      .where(sql`${t.publishedAt} IS NOT NULL`),
  ],
);

export type OutboxEvent = typeof eventsOutbox.$inferSelect;
