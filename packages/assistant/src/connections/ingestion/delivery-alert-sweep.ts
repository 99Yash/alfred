/**
 * Scheduled event-delivery health sweep (#1035, ADR-0100). A broken source sends nothing, so only a
 * pull check can notice it (the GitHub drop went unseen for weeks, #1033). The banner shows the
 * same verdict, but only when the user opens the app. Lives beside the queue because it imports
 * `@alfred/mailer`, which the alert rule must not.
 */

import { INTEGRATIONS, toMessage, type EventSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { emailSends } from "@alfred/db/schemas";
import { renderDeliveryAlertEmail } from "@alfred/mailer";
import { and, desc, eq, gt } from "drizzle-orm";
import { selectEmailableUsers, send } from "@alfred/assistant/delivery";
import { emailLogoUrl, resolveTimezone, webOrigin } from "@alfred/assistant/settings";
import { inZone, type LocalDateKey } from "@alfred/assistant/time";
import { readIntegrationAvailability } from "../availability";
import { readDeliveryAlerts, type DeliveryAlertVerdict } from "../delivery-alerts";

/**
 * One emailed alert silences the next for the same source for a week. The banner shows the live
 * state, so the email only breaks silence. Recovery is not tracked: break, fix, break again inside
 * the window sends one email.
 */
const ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cap on recent `delivery_alert` rows read. Slack, not a limit, because only this feature writes
 * the kind. An exhausted page would read as "never alerted" and re-send.
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
 * Email each broken, repairable source at most once per {@link ALERT_REPEAT_MS}. A failed send
 * throws so BullMQ retries; `send` is idempotent on its key.
 */
export async function runDeliveryAlertSweep(
  userId: string,
  now: Date = new Date(),
): Promise<DeliveryAlertSweepResult> {
  const availability = await readIntegrationAvailability(userId);
  const alerts = await readDeliveryAlerts(userId, availability.providers, now);

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
  alert: DeliveryAlertVerdict,
  day: LocalDateKey,
): Promise<"sent" | "duplicate"> {
  const integrationName = INTEGRATIONS[alert.integration].displayName;
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
    kind: "delivery_alert",
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
 * Key prefix in the `{kind}:{userId}:{subject}:{local-day}` form. Per source, so sources never
 * silence each other.
 */
function alertKeyPrefix(userId: string, source: EventSource): string {
  return `delivery_alert:${userId}:${source}:`;
}

/** Whether this source was already alerted inside the window. */
function wasAlerted(keys: readonly string[], userId: string, source: EventSource): boolean {
  const prefix = alertKeyPrefix(userId, source);

  return keys.some((key) => key.startsWith(prefix));
}

/**
 * Keys of `delivery_alert` emails actually sent inside the window. Queued or failed rows told the
 * user nothing. `status` filters on the heap, hence the cap.
 */
async function listRecentAlertKeys(userId: string, since: Date): Promise<string[]> {
  const rows = await db()
    .select({ idempotencyKey: emailSends.idempotencyKey })
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        eq(emailSends.kind, "delivery_alert"),
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
 * Repeatable job body. Scope is `selectEmailableUsers`, not every `user` row, so test rows are
 * skipped. Every user runs; failures are rethrown together so BullMQ retries.
 */
export async function runDeliveryAlertSweepForAllUsers(): Promise<DeliveryAlertSweepTally> {
  const users = await selectEmailableUsers();
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
