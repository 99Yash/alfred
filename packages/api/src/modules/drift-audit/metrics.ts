import { parseEmailAddress, toMessage } from "@alfred/contracts";
import type { TriageCategory } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, driftMetrics, emailTriage, todos } from "@alfred/db/schemas";
import { selfSenderEmail } from "@alfred/integrations/google";
import { and, eq, inArray, sql } from "drizzle-orm";
import { localDateInTimezone } from "../briefing/preferences";
import { notify, type NotifyArgs, type NotifyResult } from "../notifications/notify";
import { resolveUserTimezone } from "../user-timezone";

/**
 * Drift / invariant health metrics (PR-B of #219).
 *
 * Each metric is a pure query over the *source-of-truth* tables that the
 * #210/#211/#212 incidents were eventually caught in by a manual prod SQL
 * audit. `runDriftHealthCheck` evaluates them all, writes one `drift_metrics`
 * snapshot row per metric (the trend substrate the user-model epic #218 tunes
 * against), and fires a single `health_alert` email per *breached* metric per
 * day. Normal runs are silent — "pushed when it matters," not a routine digest
 * that re-creates the inbox noise these metrics measure.
 *
 * Thresholds are module constants — single-user, so a config table buys
 * nothing. They are the obvious revisit-knob if the inbox shape shifts.
 */

/** `urgent`/`action_needed` are the two demanding lanes whose over-tag is #210. */
const ATTENTION_CATEGORIES = [
  "urgent",
  "action_needed",
] as const satisfies readonly TriageCategory[];

/** The ingestor drops self-mail (#211), so any self-doc means the drop regressed. */
const SELF_INGESTION_THRESHOLD = 0;
/** #210 cited 26% of the inbox in the demanding lanes; 20% is the line. */
const ATTENTION_SHARE_THRESHOLD = 0.2;
/** Avoid paging on tiny samples like 1 urgent thread out of 1 classified thread. */
const ATTENTION_SHARE_MIN_TOTAL = 10;
/** Informational only — issue cited 41:1. A high bar so it speaks rarely. */
const TODO_DISMISS_DONE_THRESHOLD = 20;

export const DRIFT_METRICS = [
  "self_ingestion_count",
  "attention_share_7d",
  "todo_dismiss_done_ratio",
] as const;
export type DriftMetricName = (typeof DRIFT_METRICS)[number];

export interface MetricResult {
  metric: DriftMetricName;
  value: number;
  /** `7d` for windowed metrics; null for point counts. */
  windowLabel: string | null;
  threshold: number;
  breached: boolean;
  /** Numerator/denominator/sample ids — persisted to the snapshot row. */
  detail: Record<string, unknown>;
  /** One-line human summary, used in the breach email. */
  summary: string;
}

/**
 * Count of Alfred's own outbound mail that slipped back into `documents` in the
 * last 7d. The ingestor drops it at the boundary (#211), so this is normally 0;
 * any row means the drop regressed. Coarse `LIKE` in SQL then an exact parsed
 * match in JS (the same two-step the backfill uses) — the `LIKE` alone
 * over-matches mail that merely *mentions* the address in display text.
 * Returns null when Alfred has no parseable send identity (metric uncomputable).
 */
export async function selfIngestionCount(userId: string): Promise<MetricResult | null> {
  const self = selfSenderEmail();
  if (!self) return null;

  const candidates = await db()
    .select({
      id: documents.id,
      from: sql<string | null>`${documents.metadata}->>'from'`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        sql`${documents.createdAt} >= now() - interval '7 days'`,
        sql`lower(${documents.metadata}->>'from') like ${"%" + self + "%"}`,
      ),
    );

  const selfDocs = candidates.filter((d) => parseEmailAddress(d.from) === self);
  const count = selfDocs.length;
  return {
    metric: "self_ingestion_count",
    value: count,
    windowLabel: "7d",
    threshold: SELF_INGESTION_THRESHOLD,
    breached: count > SELF_INGESTION_THRESHOLD,
    detail: { count, self, sampleDocIds: selfDocs.slice(0, 10).map((d) => d.id) },
    summary: `${count} self-authored email(s) ingested in the last 7d (expected 0; the #211 drop regressed).`,
  };
}

/**
 * Share of threads classified in the last 7d that landed in the demanding
 * lanes (`urgent`/`action_needed`). #210 measured this at 26% and called it
 * structural over-tag. Denominator 0 → value 0, never a breach.
 */
export async function attentionShare7d(userId: string): Promise<MetricResult> {
  const rows = await db()
    .select({
      total: sql<number>`count(*)::int`,
      attention: sql<number>`count(*) filter (where ${inArray(emailTriage.category, ATTENTION_CATEGORIES)})::int`,
    })
    .from(emailTriage)
    .where(
      and(
        eq(emailTriage.userId, userId),
        sql`${emailTriage.classifiedAt} >= now() - interval '7 days'`,
      ),
    );

  const total = rows[0]?.total ?? 0;
  const attention = rows[0]?.attention ?? 0;
  const share = total === 0 ? 0 : attention / total;
  return {
    metric: "attention_share_7d",
    value: share,
    windowLabel: "7d",
    threshold: ATTENTION_SHARE_THRESHOLD,
    breached: total >= ATTENTION_SHARE_MIN_TOTAL && share > ATTENTION_SHARE_THRESHOLD,
    detail: {
      attention,
      total,
      minTotal: ATTENTION_SHARE_MIN_TOTAL,
      categories: ATTENTION_CATEGORIES,
      sharePct: Math.round(share * 1000) / 10,
    },
    summary: `${Math.round(share * 1000) / 10}% of the last 7d's classified threads are urgent/action_needed (>${ATTENTION_SHARE_THRESHOLD * 100}%, #210).`,
  };
}

/**
 * Ratio of dismissed:done Alfred-authored todos over the last 7d — how often
 * Alfred's suggestions get swatted away vs. acted on. Informational (high threshold).
 * `done` is timestamped by `completed_at`; `dismissed` has no dedicated
 * timestamp, so it's windowed on `updated_at` (the status flip bumps it).
 * `done === 0` → value is the raw dismissed count so the ratio still reads
 * sensibly instead of dividing by zero.
 */
export async function todoDismissDoneRatio(userId: string): Promise<MetricResult> {
  const rows = await db()
    .select({
      dismissed: sql<number>`count(*) filter (where ${todos.status} = 'dismissed' and ${todos.updatedAt} >= now() - interval '7 days')::int`,
      done: sql<number>`count(*) filter (where ${todos.status} = 'done' and ${todos.completedAt} >= now() - interval '7 days')::int`,
    })
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.createdBy, "agent")));

  const dismissed = rows[0]?.dismissed ?? 0;
  const done = rows[0]?.done ?? 0;
  const ratio = done === 0 ? dismissed : dismissed / done;
  return {
    metric: "todo_dismiss_done_ratio",
    value: ratio,
    windowLabel: "7d",
    threshold: TODO_DISMISS_DONE_THRESHOLD,
    breached: ratio > TODO_DISMISS_DONE_THRESHOLD,
    detail: { dismissed, done, ratio: Math.round(ratio * 100) / 100 },
    summary: `${dismissed} dismissed vs ${done} done todos in the last 7d (ratio ${Math.round(ratio * 100) / 100}).`,
  };
}

export interface DriftHealthCheckResult {
  userId: string;
  /** Every metric that produced a value this run. */
  metrics: MetricResult[];
  /** Subset that breached its threshold. */
  breached: MetricResult[];
  /** Alerts actually sent (deduped breaches that hadn't already pushed today). */
  alertsSent: number;
}

type MetricEvaluator = (userId: string) => Promise<MetricResult | null>;
type NotifyFn = (args: NotifyArgs) => Promise<NotifyResult>;

export interface RunDriftHealthCheckOptions {
  /** Test seam; production uses wall-clock now. */
  now?: Date;
  /** Test seam; production sends through Resend-backed notify(). */
  notifyFn?: NotifyFn;
  /** Test seam; production evaluates the registered drift metrics. */
  metricEvaluators?: readonly MetricEvaluator[];
  /** Test seam; production resolves the user's configured timezone. */
  timezone?: string;
}

/**
 * Evaluate every drift metric for one user, persist a snapshot row each, and
 * push a `health_alert` email per breached metric. Snapshot writes are
 * best-effort per metric (a single bad query never sinks the whole sweep);
 * the alert is idempotency-keyed
 * `health_alert:{userId}:{metric}:{YYYY-MM-DD-in-user-tz}` so a worker retry
 * — or a second check the same local day — never double-mails.
 */
export async function runDriftHealthCheck(
  userId: string,
  options: RunDriftHealthCheckOptions = {},
): Promise<DriftHealthCheckResult> {
  const now = options.now ?? new Date();
  const captureKey = localDateInTimezone("UTC", now);
  const results: MetricResult[] = [];
  const metricFailures: string[] = [];
  const evaluators = options.metricEvaluators ?? [
    selfIngestionCount,
    attentionShare7d,
    todoDismissDoneRatio,
  ];
  for (const evaluate of evaluators) {
    try {
      const result = await evaluate(userId);
      if (result) results.push(result);
    } catch (err) {
      const failure = `${evaluate.name || "anonymous_metric"}: ${toMessage(err)}`;
      metricFailures.push(failure);
      console.error(`[drift-audit] metric failed for user=${userId}: ${failure}`);
    }
  }
  // Persist all snapshots in one insert (the trend substrate). Best-effort, but
  // idempotent by `(user, metric, captureKey)` so alert-send retries do not
  // inflate the daily trend rows.
  if (results.length > 0) {
    try {
      await db()
        .insert(driftMetrics)
        .values(
          results.map((r) => ({
            userId,
            metric: r.metric,
            value: r.value,
            windowLabel: r.windowLabel,
            captureKey,
            detail: { ...r.detail, threshold: r.threshold, breached: r.breached },
          })),
        )
        .onConflictDoNothing({
          target: [driftMetrics.userId, driftMetrics.metric, driftMetrics.captureKey],
        });
    } catch (err) {
      console.error(`[drift-audit] snapshot insert failed for user=${userId}: ${toMessage(err)}`);
    }
  }

  const breached = results.filter((r) => r.breached);
  const timezone =
    breached.length > 0 ? (options.timezone ?? (await resolveUserTimezone(userId))) : "UTC";
  const today = localDateInTimezone(timezone, now);
  const notifyFn = options.notifyFn ?? notify;
  let alertsSent = 0;
  const alertFailures: string[] = [];
  for (const result of breached) {
    try {
      const email = composeHealthAlertEmail(result);
      const res = await notifyFn({
        userId,
        kind: "health_alert",
        idempotencyKey: `health_alert:${userId}:${result.metric}:${today}`,
        subject: email.subject,
        html: email.html,
        text: email.text,
        payload: { metric: result.metric, value: result.value, detail: result.detail },
      });
      if (res.status === "sent") alertsSent++;
      if (res.status === "failed") {
        alertFailures.push(`${result.metric}: ${res.error}`);
      }
    } catch (err) {
      alertFailures.push(`${result.metric}: ${toMessage(err)}`);
      console.error(
        `[drift-audit] health_alert push failed (${result.metric}) user=${userId}: ${toMessage(err)}`,
      );
    }
  }

  console.log(
    `[drift-audit] user=${userId} metrics=${results.length} breached=${breached.length} alertsSent=${alertsSent}`,
  );
  const healthCheckFailures: string[] = [];
  if (metricFailures.length > 0) {
    const prefix = results.length === 0 ? "all metrics failed" : "metric evaluator failed";
    healthCheckFailures.push(`${prefix}: ${metricFailures.join("; ")}`);
  }
  if (alertFailures.length > 0) {
    healthCheckFailures.push(`health_alert send failed: ${alertFailures.join("; ")}`);
  }
  if (healthCheckFailures.length > 0) {
    throw new Error(
      `[drift-audit] health check failed for user=${userId}: ${healthCheckFailures.join("; ")}`,
    );
  }
  return { userId, metrics: results, breached, alertsSent };
}

/** Minimal operator-facing breach email. One metric per send. */
function composeHealthAlertEmail(result: MetricResult): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `[Alfred health] ${result.metric} drift`;
  const detailLines = Object.entries(result.detail)
    .map(([k, v]) => `${k}: ${JSON.stringify(v) ?? String(v)}`)
    .join("\n");
  const text = `${result.summary}\n\nthreshold: ${result.threshold}\nvalue: ${result.value}\n\n${detailLines}`;
  const htmlDetailLines = Object.entries(result.detail)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(JSON.stringify(v) ?? String(v))}`)
    .join("\n");
  const html =
    `<p><strong>${escapeHtml(result.metric)}</strong> breached.</p>` +
    `<p>${escapeHtml(result.summary)}</p>` +
    `<pre>threshold: ${escapeHtml(result.threshold)}\n` +
    `value: ${escapeHtml(result.value)}\n\n${htmlDetailLines}</pre>`;
  return { subject, html, text };
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}
