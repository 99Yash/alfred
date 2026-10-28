/**
 * Scheduled event-delivery health sweep (#1035, ADR-0100). A broken source sends nothing, so only a
 * pull check can notice it (the GitHub drop went unseen for weeks, #1033). The banner shows the
 * same verdict, but only when the user opens the app. Lives beside the queue because it imports
 * `@alfred/mailer`, which the alert rule must not.
 */

import { INTEGRATIONS, toMessage, type McpConnectionAlert } from "@alfred/contracts";
import { db } from "@alfred/db";
import { emailSends } from "@alfred/db/schemas";
import { renderDeliveryAlertEmail } from "@alfred/mailer";
import { and, asc, eq, gt } from "drizzle-orm";
import { selectEmailableUsers, send } from "@alfred/assistant/delivery";
import { emailLogoUrl, settings, webOrigin } from "@alfred/assistant/settings";
import { inZone, type LocalDateKey } from "@alfred/assistant/time";
import { readIntegrationAvailability } from "../availability";
import { readDeliveryAlerts, type DeliveryAlertVerdict } from "../delivery-alerts";
import { readMcpConnectionAlerts } from "../mcp/connection-alerts";
import {
  deliveryConnectionKey,
  mcpConnectionKey,
  type BrokenConnection,
} from "../broken-connection-facts";
import { composeDeliveryAlertCopy } from "./delivery-alert-copy";
import { logger } from "@alfred/logging";

/**
 * One emailed alert silences the next for the same source for a week. The banner shows the live
 * state, so the email only breaks silence. Recovery is not tracked: break, fix, break again inside
 * the window sends one email.
 */
const ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Page size for recent sends. Read every page: MCP connections have no count limit, so a fixed
 * lookback cap could hide an alert that must still silence a repeat.
 */
const ALERT_LOOKBACK_PAGE_SIZE = 100;

/**
 * One thing the sweep can email about. `subject` keys the repeat window: an event source, or
 * `mcp:{connectionId}` for an MCP connection (ADR-0100 amendment 2026-10-28, item 4).
 * `connection` holds the facts the model writes from.
 */
interface SweepAlert {
  subject: string;
  connection: BrokenConnection;
  url: string;
  payload: Record<string, string>;
}

function fromDeliveryVerdict(verdict: DeliveryAlertVerdict): SweepAlert {
  const alert = { integration: verdict.integration, reason: verdict.reason };

  return {
    subject: verdict.source,
    connection: {
      kind: "delivery",
      key: deliveryConnectionKey(alert),
      name: INTEGRATIONS[verdict.integration].displayName,
      alert,
    },
    url: `${webOrigin()}/integrations/${verdict.integration}`,
    payload: { source: verdict.source, integration: verdict.integration, reason: verdict.reason },
  };
}

function fromMcpAlert(alert: McpConnectionAlert): SweepAlert {
  return {
    subject: `mcp:${alert.connectionId}`,
    connection: { kind: "mcp", key: mcpConnectionKey(alert), name: alert.label, alert },
    url: `${webOrigin()}/integrations`,
    payload: { connectionId: alert.connectionId, label: alert.label, status: alert.status },
  };
}

interface DeliveryAlertSweepResult {
  userId: string;
  /** Sources and MCP connections that are broken and repairable right now. */
  alerts: number;
  /** Of those, the ones this run emailed. */
  sent: number;
}

/**
 * Email each broken, repairable source at most once per {@link ALERT_REPEAT_MS}. A failed send
 * throws so BullMQ retries; `send` is idempotent on its key.
 */
async function runDeliveryAlertSweep(
  userId: string,
  now: Date = new Date(),
): Promise<DeliveryAlertSweepResult> {
  const availability = await readIntegrationAvailability(userId);

  const [deliveryAlerts, mcpAlerts] = await Promise.all([
    readDeliveryAlerts(userId, availability.providers, now),
    readMcpConnectionAlerts(userId),
  ]);

  const alerts = [...deliveryAlerts.map(fromDeliveryVerdict), ...mcpAlerts.map(fromMcpAlert)];

  if (alerts.length === 0) return { userId, alerts: 0, sent: 0 };

  const recentKeys = await listRecentAlertKeys(userId, new Date(now.getTime() - ALERT_REPEAT_MS));
  const due = alerts.filter((alert) => !wasAlerted(recentKeys, userId, alert.subject));

  if (due.length === 0) return { userId, alerts: alerts.length, sent: 0 };

  const day = inZone(await settings({ userId }).timezone()).day(now);
  const failures: string[] = [];
  let sent = 0;

  for (const alert of due) {
    try {
      const result = await sendDeliveryAlert(userId, alert, day);

      if (result === "sent") sent++;
    } catch (err) {
      failures.push(`${alert.subject}: ${toMessage(err)}`);
    }
  }

  logger.info(
    `[delivery-alert] user=${userId} broken=${alerts.length} due=${due.length} sent=${sent}`,
  );

  if (failures.length > 0) {
    throw new Error(`[delivery-alert] send failed for user=${userId}: ${failures.join("; ")}`);
  }

  return { userId, alerts: alerts.length, sent };
}

async function sendDeliveryAlert(
  userId: string,
  alert: SweepAlert,
  day: LocalDateKey,
): Promise<"sent" | "duplicate"> {
  const { name } = alert.connection;
  const copy = await composeDeliveryAlertCopy(userId, alert.connection);

  const html = await renderDeliveryAlertEmail({
    headline: copy.headline,
    body: copy.body,
    name,
    url: alert.url,
    logoUrl: emailLogoUrl(),
  });

  const text = [copy.headline, copy.body, `Reconnect ${name}: ${alert.url}`]
    .filter((part) => part.length > 0)
    .join("\n\n");

  const result = await send({
    userId,
    kind: "delivery_alert",
    idempotencyKey: `${alertKeyPrefix(userId, alert.subject)}${day}`,
    subject: copy.headline,
    html,
    text,
    payload: alert.payload,
  });

  if (result.status === "failed") throw new Error(result.error);

  return result.status;
}

/**
 * Key prefix in the `{kind}:{userId}:{subject}:{local-day}` form. Per subject, so sources and
 * connections never silence each other.
 */
function alertKeyPrefix(userId: string, subject: string): string {
  return `delivery_alert:${userId}:${subject}:`;
}

/** Whether this subject was already alerted inside the window. */
function wasAlerted(keys: readonly string[], userId: string, subject: string): boolean {
  const prefix = alertKeyPrefix(userId, subject);

  return keys.some((key) => key.startsWith(prefix));
}

/**
 * Keys of every `delivery_alert` email sent inside the window. Queued or failed rows told the
 * user nothing. The primary key gives each page a stable, exclusive cursor.
 */
async function listRecentAlertKeys(userId: string, since: Date): Promise<string[]> {
  const keys: string[] = [];
  let afterId: string | undefined;

  for (;;) {
    const rows = await db()
      .select({ id: emailSends.id, idempotencyKey: emailSends.idempotencyKey })
      .from(emailSends)
      .where(
        and(
          eq(emailSends.userId, userId),
          eq(emailSends.kind, "delivery_alert"),
          eq(emailSends.status, "sent"),
          gt(emailSends.createdAt, since),
          afterId === undefined ? undefined : gt(emailSends.id, afterId),
        ),
      )
      .orderBy(asc(emailSends.id))
      .limit(ALERT_LOOKBACK_PAGE_SIZE);

    keys.push(...rows.map((row) => row.idempotencyKey));
    const last = rows.at(-1);

    if (rows.length < ALERT_LOOKBACK_PAGE_SIZE || !last) return keys;

    afterId = last.id;
  }
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
      logger.error({ err }, `[delivery-alert] sweep failed user=${row.id}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`[delivery-alert] sweep failed: ${failures.join("; ")}`);
  }

  return { users: users.length, broken, sent };
}
