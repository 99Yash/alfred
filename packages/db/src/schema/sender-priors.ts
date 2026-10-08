import { TRIAGE_CATEGORIES, type TriageCategory } from "@alfred/contracts";
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { inList, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Category counts per bulk sender (ADR-0051). An input to the classifier, not a verdict.
 * The model still runs on every email.
 * Never written for a human sender or for the user's own sent mail.
 */
export const senderPriors = pgTable(
  "sender_priors",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Lowercased email, or `service:<botSlug>`. */
    senderKey: text("sender_key").notNull(),
    /** For example `{ newsletter: 12, marketing: 1 }`. */
    categoryCounts: jsonb("category_counts")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, number>>(),
    lastCategory: text("last_category").$type<TriageCategory>(),
    displayName: text("display_name"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.senderKey] }),
    // NULL passes a CHECK.
    check(
      "sender_priors_last_category_valid",
      sql`${t.lastCategory} IN (${inList(TRIAGE_CATEGORIES)})`,
    ),
  ],
);

export type SenderPrior = typeof senderPriors.$inferSelect;
