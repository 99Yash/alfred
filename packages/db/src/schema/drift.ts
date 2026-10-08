import {
  bigserial,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Health-metric snapshots, one row per metric per day, so drift shows as a trend.
 * A threshold breach also sends one `health_alert` email.
 */
export const driftMetrics = pgTable(
  "drift_metrics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Text, not a pg enum, so a new metric needs no migration. */
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    /** For example `7d`. NULL for point counts. Not `window`, which is a SQL reserved word. */
    windowLabel: text("window_label"),
    /** The capture day, so a retry on the same day adds no row. */
    captureKey: text("capture_key").notNull(),
    /** Numerator, denominator, sample ids, threshold, `breached`. */
    detail: jsonb("detail"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    index("drift_metrics_user_metric_idx").on(t.userId, t.metric, t.capturedAt),
    uniqueIndex("drift_metrics_user_metric_capture_key_idx").on(t.userId, t.metric, t.captureKey),
  ],
);

export type DriftMetric = typeof driftMetrics.$inferSelect;
