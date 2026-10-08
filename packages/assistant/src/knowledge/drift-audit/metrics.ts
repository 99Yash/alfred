import { parseEmailAddress, toMessage } from "@alfred/contracts";
import type { IanaTimezone, JsonObject, TriageCategory } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, driftMetrics, emailTriage, todos } from "@alfred/db/schemas";
import { selfSenderEmail } from "@alfred/integrations/google";
import { and, eq, inArray, sql } from "drizzle-orm";
import { send, type SendArgs, type SendResult } from "@alfred/assistant/delivery";
import { resolveTimezone } from "@alfred/assistant/settings";
import { DEFAULT_USER_TIMEZONE, inZone } from "@alfred/assistant/time";

/**
 * Drift and invariant health metrics (#219). Each run writes a `drift_metrics`
 * snapshot per metric and sends one `health_alert` email per breached metric
 * per day. Healthy runs are silent.
 */

/** The two demanding lanes whose over-tagging was #210. */
const ATTENTION_CATEGORIES = [
  "urgent",
  "action_needed",
] as const satisfies readonly TriageCategory[];

/** The ingestor drops self-mail (#211), so any self doc means a regression. */
const SELF_INGESTION_THRESHOLD = 0;

/** #210 found 26% of the inbox in the demanding lanes; 20% is the line. */
const ATTENTION_SHARE_THRESHOLD = 0.2;

/** Do not page on tiny samples like 1 urgent of 1. */
const ATTENTION_SHARE_MIN_TOTAL = 10;

/** Informational. The issue cited 41:1, so the bar is high. */
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
  /** Persisted to the snapshot row. */
  detail: JsonObject;
  /** One line, used in the breach email. */
  summary: string;
}

/**
 * Alfred's own outbound mail that came back into `documents` in the last 7d.
 * SQL `LIKE` first, then an exact parse: `LIKE` also matches display text.
 * Null when Alfred has no parseable send identity.
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

/** Share of threads classified in the last 7d that landed in a demanding lane. Zero denominator gives 0. */
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
 * Dismissed:done ratio of Alfred's todos over 7d. `dismissed` has no timestamp,
 * so it uses `updated_at`. With no `done`, the value is the dismissed count.
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
  metrics: MetricResult[];
  breached: MetricResult[];
  /** Alerts sent; a breach already alerted today is skipped. */
  alertsSent: number;
}

type MetricEvaluator = (userId: string) => Promise<MetricResult | null>;

type NotifyFn = (args: SendArgs) => Promise<SendResult>;

export interface RunDriftHealthCheckOptions {
  /** Test seam. */
  now?: Date;
  /** Test seam. */
  notifyFn?: NotifyFn;
  /** Test seam. */
  metricEvaluators?: readonly MetricEvaluator[];
  /** Test seam; production resolves the user's timezone. */
  timezone?: IanaTimezone;
}

/**
 * Evaluate each metric, store the snapshots, and alert per breach. A failed
 * metric does not stop the others. The alert key holds the user's local day,
 * so a retry the same day does not mail twice.
 */
export async function runDriftHealthCheck(
  userId: string,
  options: RunDriftHealthCheckOptions = {},
): Promise<DriftHealthCheckResult> {
  const now = options.now ?? new Date();
  const captureKey = inZone(DEFAULT_USER_TIMEZONE).day(now);
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

  // One insert, idempotent on `(user, metric, captureKey)`, so retries do not add trend rows.
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
    breached.length > 0
      ? (options.timezone ?? (await resolveTimezone(userId)))
      : DEFAULT_USER_TIMEZONE;

  const today = inZone(timezone).day(now);
  const notifyFn = options.notifyFn ?? send;
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

/** One metric per email. */
interface HealthAlertEmail {
  subject: string;
  html: string;
  text: string;
}

function composeHealthAlertEmail(result: MetricResult): HealthAlertEmail {
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
