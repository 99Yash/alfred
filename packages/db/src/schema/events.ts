import { sql } from "drizzle-orm";
import { bigserial, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * Durable transactional outbox for user-scoped realtime events.
 *
 * Producers INSERT a row inside the same transaction as the domain write that
 * triggered the event. A relay worker (LISTEN/NOTIFY-driven, in
 * packages/api/src/events/outbox-relay.ts) drains unpublished rows, publishes
 * them to Redis Pub/Sub on `user-events:u:<userId>`, then stamps
 * `published_at`. SSE consumers subscribe to that channel and replay missed
 * rows on reconnect via `id > Last-Event-ID`.
 *
 * Replicache pokes intentionally do NOT go through this table — they have a
 * separate, lower-latency bus (events/replicache-events.ts) because pokes are
 * idempotent hints, not durable state.
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
  ],
);
