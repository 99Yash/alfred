import { sql } from "drizzle-orm";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Per-sender category histogram (ADR-0051, triage v3).
 *
 * Keyed `(user_id, sender_key)` where `sender_key` is the EXACT lowercased
 * sender address (`alerts@stripe.com`) or `service:<botSlug>` for a
 * recognized bot (`service:coderabbit`). Stores a raw category histogram in
 * `category_counts` (`{ newsletter: 12, marketing: 1 }`) — NOT a verdict.
 *
 * This is a *fed signal* to the always-on cheap classifier, never a model
 * bypass: the model runs on every email and the histogram is refreshed on
 * every classification, so there is no staleness or cache-invalidation
 * problem to solve. Because the model always runs, there is intentionally no
 * `confidence`/`locked`/`source`/dominant-share gating (those were artifacts
 * of the rejected bypass design — ADR-0051 alt (h)).
 *
 * NEVER written for a human sender (`effectiveAuthor: 'person'` — a person's
 * category is per-message) and NEVER for the user's own sent mail (you are
 * not a sender to cache). This is explicitly a *bulk-sender* signal:
 * newsletters, marketing, payment notices, digests, bots.
 */
export const senderPriors = pgTable(
  "sender_priors",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Exact lowercased email, or `service:<botSlug>`. Never a human address. */
    senderKey: text("sender_key").notNull(),
    /** Raw category histogram, e.g. `{ newsletter: 12, marketing: 1 }`. */
    categoryCounts: jsonb("category_counts")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, number>>(),
    /** Most recent category Alfred assigned this sender — a cheap "latest" hint. */
    lastCategory: text("last_category"),
    /** Last-seen display name from the `From:` header, for debugging/UI. */
    displayName: text("display_name"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [primaryKey({ columns: [t.userId, t.senderKey] })],
);

export type SenderPrior = typeof senderPriors.$inferSelect;
