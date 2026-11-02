import {
  credentialSatisfies,
  deliveryAlertSchema,
  eventDeliveryAccounts,
  EVENT_SOURCES,
  isLiveProviderSlug,
  LIVE_PROVIDERS,
  type CredentialRowsByProvider,
  type DeliveryAlert,
  type EventSource,
  type LiveProviderSlug,
} from "@alfred/contracts";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import { eventDeliveryRows, readEventSourceHealth } from "./event-source-health";
import type { EventDeliveryFailure, EventDeliveryRecovery } from "./ingress/descriptor";
import { logger } from "@alfred/logging";

/**
 * Which delivery failures to show a person (ADR-0100). The banner, the sweep email, and the
 * briefing block all use this. A verdict must be `broken`, have a `connect` recovery to a live
 * integration, and be repairable on this instance ({@link alertableIntegration}). The banner and the
 * sweep also drop a duplicate of a reconnect nag ({@link nagsOwnCredential}).
 * Covers every `EventSource`, not only inbound ones: Gmail watch lapses are a real incident class.
 */ export interface DeliveryAlertVerdict {
  /** Server-side only: keys the email repeat window. */
  source: EventSource;
  integration: LiveProviderSlug;
  reason: string;
}

/**
 * Broken sources the user can restore, for the banner and the sweep. Drops an integration that a
 * credential banner already nags about ({@link nagsOwnCredential}), so one screen asks once.
 * `rows` is the caller's credential read, so no extra query.
 */
export async function readDeliveryAlerts(
  userId: string,
  rows: CredentialRowsByProvider,
  now: Date = new Date(),
): Promise<DeliveryAlertVerdict[]> {
  const suppressed = nagsOwnCredential(rows);
  const verdicts = await readBrokenConnections(userId, rows, now);

  return verdicts.filter((verdict) => !suppressed.has(verdict.integration));
}

/**
 * The same rule without the credential-nag dedup. The briefing reads this: an email has no
 * credential banner beside it, so a dedup there would hide the break (ADR-0100 amendment
 * 2026-10-28). A read fault throws; the caller decides what a fault means.
 */
export async function readBrokenConnections(
  userId: string,
  rows: CredentialRowsByProvider,
  now: Date = new Date(),
): Promise<DeliveryAlertVerdict[]> {
  const health = await readEventSourceHealth(userId, rows, now);
  const unrepairable = unrepairableHere();

  return EVENT_SOURCES.flatMap((source): DeliveryAlertVerdict[] => {
    const entry = health[source];

    const verdicts =
      entry.grain === "source"
        ? [entry.health]
        : eventDeliveryRows(rows, entry.accounts).map(entry.healthOf);

    return verdicts.flatMap((verdict) => {
      if (verdict.healthy) return [];
      const integration = alertableIntegration(verdict, unrepairable);

      return integration ? [{ source, integration, reason: verdict.reason }] : [];
    });
  });
}

/**
 * The live integration that a person reconnects to repair `failure` on this instance, or `null`
 * when no reconnect here repairs it. This is the one rule for a reconnect row: the delivery alert
 * and each briefing `not_delivered` row use it, so the two rows always merge.
 *
 * A `silent` failure is a delivery gap in the activity record (`readActivityCoverage`). Only a gap
 * to now has a `connect` recovery: it is a break that the delivery health did not see.
 */
export function alertableIntegration(
  failure: {
    readonly cause: EventDeliveryFailure["cause"] | "silent";
    readonly recovery: EventDeliveryRecovery;
  },
  unrepairable: ReadonlySet<LiveProviderSlug> = unrepairableHere(),
): LiveProviderSlug | null {
  if (failure.cause !== "broken" && failure.cause !== "silent") return null;

  if (failure.recovery.kind !== "connect") return null;
  const { integration } = failure.recovery;

  if (!isLiveProviderSlug(integration)) return null;

  return unrepairable.has(integration) ? null : integration;
}

/**
 * Integrations with an active row that fails the connected rule (ADR-0093).
 * The scope-gap and pre-App GitHub items of `useConnectionAttention` already ask for that reconnect.
 */
function nagsOwnCredential(rows: CredentialRowsByProvider): ReadonlySet<LiveProviderSlug> {
  const nagged = new Set<LiveProviderSlug>();

  for (const entry of LIVE_PROVIDERS) {
    const active = (rows.get(entry.provider) ?? []).filter((row) => row.status === "active");

    if (active.length === 0) continue;

    if (!active.some((row) => credentialSatisfies(entry.credential, row))) nagged.add(entry.slug);
  }

  return nagged;
}

const GMAIL_INTEGRATION = eventDeliveryAccounts("gmail").integration;

/**
 * Off production, Gmail mailbox writes are off (ADR-0081), so no watch is installed
 * and a reconnect cannot fix it. Hide the alert; readiness still refuses the trigger.
 */
function unrepairableHere(): ReadonlySet<LiveProviderSlug> {
  return gmailMailboxWritesEnabled() ? new Set() : new Set([GMAIL_INTEGRATION]);
}

/**
 * At most one alert per integration; the first in registry order wins.
 * Drop a verdict that fails the schema: the web parses the whole status body,
 * so one bad `reason` would blank every tile.
 */
export function toDeliveryAlerts(alerts: readonly DeliveryAlertVerdict[]): DeliveryAlert[] {
  const seen = new Set<LiveProviderSlug>();
  const wire: DeliveryAlert[] = [];

  for (const alert of alerts) {
    if (seen.has(alert.integration)) continue;

    const parsed = deliveryAlertSchema.safeParse({
      integration: alert.integration,
      reason: alert.reason,
    });

    if (!parsed.success) {
      logger.error(
        `[integrations] delivery alert for source=${alert.source} does not fit the wire schema; dropped: ${parsed.error.message}`,
      );
      continue;
    }

    seen.add(alert.integration);
    wire.push(parsed.data);
  }

  return wire;
}
