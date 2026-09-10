/**
 * The scheduled inbound-delivery health sweep (#1035, ADR-0100) — worker side.
 *
 * A source that produces deliveries only while it is healthy cannot report its
 * own silence: it sends nothing when it breaks, so no push signal exists to
 * react to. Only a pull check answers the question, and nothing was running
 * one. That is how the GitHub webhook drop went unnoticed for weeks (#1033):
 * no active credential matched the App installation, every delivery was
 * acknowledged and dropped, and Alfred said nothing.
 *
 * The app banner reads the same verdict live, so it is always current, but it
 * waits for the user to open Alfred. This sweep is the half that does not wait.
 *
 * It lives beside the queue that runs it, not beside the health reader, because
 * it reaches `../../delivery` and `@alfred/mailer`; the ingress door stays light
 * enough for workflow readiness to import.
 */

import { INTEGRATION_DISPLAY_NAMES, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { emailSends, user as userTable } from "@alfred/db/schemas";
import { renderDeliveryAlertEmail } from "@alfred/mailer";
import { and, desc, eq, gt } from "drizzle-orm";
import { send } from "@alfred/assistant/delivery";
import { emailLogoUrl, resolveTimezone, webOrigin } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import { readInboundDeliveryAlerts, type InboundDeliveryAlert } from "../delivery-alerts";

/**
 * How long one emailed alert silences the next one for the same source.
 *
 * The banner already states the live truth every time the user opens the app,
 * so this email exists only to break silence. A day would nag about a state the
 * user can already see; a week is long enough to stay news and short enough
 * that a subscription broken in the background is raised again rather than
 * forgotten.
 *
 * Accepted residual: recovery is not observed. A source that breaks, is
 * repaired, and breaks again inside the window is emailed once, not twice. The
 * banner carries the second break in the meantime, because it reads the verdict
 * live rather than from this history.
 */
const ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many recent `health_alert` rows the window read pulls back. The window is
 * a week and this alert is at most one row per source per week, so the cap only
 * bounds the read against the drift alerts that share the kind.
 */
const ALERT_LOOKBACK_LIMIT = 50;

export interface DeliveryAlertSweepResult {
  userId: string;
  /** Sources that are broken and repairable right now. */
  alerts: number;
  /** Of those, the ones this run emailed. */
  sent: number;
}

/**
 * Alert the user about every inbound source that stopped delivering and that
 * they can restore, at most once per source per {@link ALERT_REPEAT_MS}.
 *
 * A failed send throws so BullMQ retries the sweep. `send` is idempotent on its
 * key, so a retry after a partial run re-sends nothing that already left.
 */
export async function runDeliveryAlertSweep(
  userId: string,
  now: Date = new Date(),
): Promise<DeliveryAlertSweepResult> {
  const alerts = await readInboundDeliveryAlerts(userId);
  if (alerts.length === 0) return { userId, alerts: 0, sent: 0 };

  const recentKeys = await listRecentAlertKeys(userId, new Date(now.getTime() - ALERT_REPEAT_MS));
  const due = alerts.filter((alert) => !wasAlerted(recentKeys, userId, alert.source));
  if (due.length === 0) return { userId, alerts: alerts.length, sent: 0 };

  const day = inZone(await resolveTimezone(userId)).day(now);
  const failures: string[] = [];
  let sent = 0;

  for (const alert of due) {
    try {
      const result = await sendDeliveryAlert(userId, alert, day);
      if (result === "sent") sent++;
    } catch (err) {
      failures.push(`${alert.source}: ${toMessage(err)}`);
    }
  }

  console.log(
    `[delivery-alert] user=${userId} broken=${alerts.length} due=${due.length} sent=${sent}`,
  );
  if (failures.length > 0) {
    throw new Error(`[delivery-alert] send failed for user=${userId}: ${failures.join("; ")}`);
  }
  return { userId, alerts: alerts.length, sent };
}

async function sendDeliveryAlert(
  userId: string,
  alert: InboundDeliveryAlert,
  day: string,
): Promise<"sent" | "duplicate"> {
  const integrationName = INTEGRATION_DISPLAY_NAMES[alert.integration];
  const integrationUrl = `${webOrigin()}/integrations/${alert.integration}`;
  const subject = `Alfred stopped receiving ${integrationName} activity`;
  const html = await renderDeliveryAlertEmail({
    integrationName,
    reason: alert.reason,
    integrationUrl,
    logoUrl: emailLogoUrl(),
  });
  const text = [
    subject,
    "",
    `${alert.reason}.`,
    "",
    `Reconnect ${integrationName}: ${integrationUrl}`,
  ].join("\n");

  const result = await send({
    userId,
    kind: "health_alert",
    idempotencyKey: `${alertKeyPrefix(userId, alert.source)}${day}`,
    subject,
    html,
    text,
    payload: { source: alert.source, integration: alert.integration, reason: alert.reason },
  });
  if (result.status === "failed") throw new Error(result.error);
  return result.status;
}

/**
 * The prefix every delivery alert's idempotency key carries, following the
 * `health_alert:{userId}:{subject}:{local-day}` convention the `email_sends`
 * schema documents. The source sits in the subject segment, so one broken
 * source never silences another.
 */
function alertKeyPrefix(userId: string, source: string): string {
  return `health_alert:${userId}:inbound_delivery.${source}:`;
}

/**
 * Whether a delivery alert for this source already went out inside the window.
 * Pure over the keys, so the repeat rule is readable without a database.
 */
function wasAlerted(keys: readonly string[], userId: string, source: string): boolean {
  const prefix = alertKeyPrefix(userId, source);
  return keys.some((key) => key.startsWith(prefix));
}

/**
 * Idempotency keys of the `health_alert` emails this user actually received
 * inside the window.
 *
 * `sent` only: a queued or failed row means the user was told nothing, so the
 * source still owes them an alert. The read is covered by
 * `email_sends_user_kind_idx` on `(user_id, kind, created_at)`.
 */
async function listRecentAlertKeys(userId: string, since: Date): Promise<string[]> {
  const rows = await db()
    .select({ idempotencyKey: emailSends.idempotencyKey })
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        eq(emailSends.kind, "health_alert"),
        eq(emailSends.status, "sent"),
        gt(emailSends.createdAt, since),
      ),
    )
    .orderBy(desc(emailSends.createdAt))
    .limit(ALERT_LOOKBACK_LIMIT);
  return rows.map((row) => row.idempotencyKey);
}

export interface DeliveryAlertSweepTally {
  users: number;
  /** Sources broken and repairable across every user. */
  broken: number;
  sent: number;
}

/**
 * The repeatable job body: sweep every user.
 *
 * Single-user today; the per-user fan-out carries us forward. One user's
 * failure must not hide the rest, so every user runs and the failures are
 * rethrown together at the end — BullMQ then retries the sweep, and `send` is
 * idempotent on its key, so the users already alerted are not alerted twice.
 */
export async function runDeliveryAlertSweepForAllUsers(): Promise<DeliveryAlertSweepTally> {
  const users = await db().select({ id: userTable.id }).from(userTable);
  const failures: string[] = [];
  let broken = 0;
  let sent = 0;
  for (const row of users) {
    try {
      const result = await runDeliveryAlertSweep(row.id);
      broken += result.alerts;
      sent += result.sent;
    } catch (err) {
      const message = toMessage(err);
      failures.push(`${row.id}: ${message}`);
      console.error(`[delivery-alert] sweep failed user=${row.id}:`, message);
    }
  }
  if (failures.length > 0) {
    throw new Error(`[delivery-alert] sweep failed: ${failures.join("; ")}`);
  }
  return { users: users.length, broken, sent };
}
