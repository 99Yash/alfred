import { bigserial, index, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import { lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Drift / invariant-health snapshots (PR-B of #219).
 *
 * The #210/#211/#212 incidents were each found by a manual prod SQL audit, not
 * by any signal the system raised — self-ingestion (#211) ran ~9 days before a
 * human noticed. This table is the measurability substrate the user-model epic
 * (#218) tunes against: a scheduled health check (folded into the daily memory
 * sweep) writes one snapshot row per metric per run, so a metric trends over
 * time instead of being a point-in-time SQL query an operator has to remember
 * to run. A threshold breach additionally fires a single `health_alert` email
 * ("pushed when it matters"); normal runs are silent and only leave the trend.
 *
 * Complementary to `agent_decision_traces`, not layered on it: drift metrics
 * read the *source-of-truth* tables (`documents` / `email_triage` / `todos`)
 * and raise the flag; the traces explain a specific tag when an operator drills
 * in after a breach. v1 does not aggregate over traces.
 *
 * `detail` is plain `jsonb` (numerator/denominator, sample ids, threshold,
 * breached) — variable-shape, matching the other agent-family sinks. No
 * retention machinery v1 (≤ a handful of rows/day; CASCADE cleans up on user
 * delete).
 */
export const driftMetrics = pgTable(
  "drift_metrics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Metric discriminator: `self_ingestion_count` | `attention_share_7d` |
     * `todo_dismiss_done_ratio`. Stored as text (not a pg enum) so adding a
     * metric is a code change, not a migration.
     */
    metric: text("metric").notNull(),
    /** The scalar value at capture time. */
    value: real("value").notNull(),
    /**
     * Window the value was computed over, e.g. `7d`. Null for point counts.
     * Named `window_label`, not `window` — `window` is a SQL reserved word and
     * this column is read by raw `railway ssh` drift queries.
     */
    windowLabel: text("window_label"),
    /** Numerator/denominator, sample ids, threshold, `breached:boolean`. */
    detail: jsonb("detail"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [index("drift_metrics_user_metric_idx").on(t.userId, t.metric, t.capturedAt)],
);

export type DriftMetric = typeof driftMetrics.$inferSelect;
