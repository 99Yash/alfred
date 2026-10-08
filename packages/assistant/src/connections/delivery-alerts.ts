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
import type { EventDeliveryFailure } from "./ingress/descriptor";

/**
 * Which delivery failures to show a person (ADR-0100). The banner and the email both use this.
 * A verdict must be `broken`, have a `connect` recovery to a live integration,
 * not duplicate a reconnect nag ({@link nagsOwnCredential}), and be repairable
 * on this instance ({@link unrepairableHere}).
 * Covers every `EventSource`, not only inbound ones: Gmail watch lapses are a real incident class.
 */ export interface DeliveryAlertVerdict {
  /** Server-side only: keys the email repeat window. */
  source: EventSource;
  integration: LiveProviderSlug;
  reason: string;
}

/** Broken sources the user can restore. `rows` is the caller's credential read, so no extra query. */
export async function readDeliveryAlerts(
  userId: string,
  rows: CredentialRowsByProvider,
  now: Date = new Date(),
): Promise<DeliveryAlertVerdict[]> {
  const health = await readEventSourceHealth(userId, rows, now);
  const suppressed = nagsOwnCredential(rows);
  const unrepairable = unrepairableHere();

  return EVENT_SOURCES.flatMap((source): DeliveryAlertVerdict[] => {
    const entry = health[source];

    const verdicts =
      entry.grain === "source"
        ? [entry.health]
        : eventDeliveryRows(rows, entry.accounts).map(entry.healthOf);

    return verdicts.flatMap((verdict) =>
      verdict.healthy ? [] : alertable(source, verdict, suppressed, unrepairable),
    );
  });
}

function alertable(
  source: EventSource,
  verdict: EventDeliveryFailure,
  suppressed: ReadonlySet<LiveProviderSlug>,
  unrepairable: ReadonlySet<LiveProviderSlug>,
): DeliveryAlertVerdict[] {
  if (verdict.cause !== "broken") return [];

  if (verdict.recovery.kind !== "connect") return [];
  const { integration } = verdict.recovery;

  if (!isLiveProviderSlug(integration)) return [];

  if (suppressed.has(integration)) return [];

  if (unrepairable.has(integration)) return [];

  return [{ source, integration, reason: verdict.reason }];
}

/**
 * Integrations with an active row that fails the connected rule (ADR-0093).
 * `ScopeGapBanner` and `GithubReconnectBanner` already ask for that reconnect.
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
      console.error(
        `[integrations] delivery alert for source=${alert.source} does not fit the wire schema; dropped: ${parsed.error.message}`,
      );
      continue;
    }

    seen.add(alert.integration);
    wire.push(parsed.data);
  }

  return wire;
}
