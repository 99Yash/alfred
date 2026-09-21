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
 * The alert surface rule for event delivery health (ADR-0100).
 *
 * A source that produces deliveries only while it is healthy cannot report its
 * own silence: it sends nothing when it breaks, so no push signal exists to
 * react to. Only a pull check answers the question. `readEventSourceHealth` is
 * that pull read, and it answers a broader question than any surface should
 * print. This module is the one place that narrows the verdict to something
 * worth showing a person, so the banner and the emailed alert cannot disagree
 * about what counts.
 *
 * Four conditions, and a verdict must meet all of them:
 *
 * 1. **The user lost something.** `cause: "broken"` is the whole of it. A
 *    source nobody connected never delivered, and a source with no health
 *    signal proves nothing by its silence. Workflow readiness refuses a trigger
 *    on either, correctly, because it cannot arm one. A person cannot repair
 *    either, so neither is an alert.
 * 2. **The user can act.** The verdict's own recovery must name an integration
 *    whose connect flow restores deliveries, and that integration must be live
 *    so a page exists to send the user to. A `retry` or `none` recovery
 *    describes delivery that time or an operator restores; ADR-0097 already
 *    classes both as `trigger_degraded`, meaning no user action. Printing one
 *    asks a person to fix something they hold no control over, and the reason
 *    behind such a verdict is written for an operator — it names environment
 *    variables and deployment facts. It stays in the log.
 * 3. **No other surface is already asking for the same click.**
 *    {@link nagsOwnCredential} decides that, and it decides it HERE rather than
 *    in the web, so that the banner and the email suppress the same states. The
 *    first revision of this feature put the test in the React hook, which left
 *    the sweep emailing a state no banner could show.
 * 4. **This instance can perform the repair.** A non-prod instance never
 *    installs a Gmail watch — `gmailMailboxWritesEnabled()` defaults off outside
 *    production (ADR-0081) — so every Gmail account reads `WATCH_NOT_INSTALLED`.
 *    That verdict is honest for readiness, but the absence is the environment's
 *    choice, not a subscription that lapsed, and the user's reconnect would not
 *    install a watch either. {@link unrepairableHere} drops it from the surface
 *    rule so the banner and the email stay quiet while readiness keeps refusing
 *    the trigger exactly as before.
 *
 * The fold is over every `EventSource`, not the inbound ones only. Gmail's
 * Pub/Sub watch lapses (`WATCH_NOT_INSTALLED`, `cause: "broken"`, recovery
 * `connect gmail`) and is a realized incident class here, so an inbound-only
 * fold would have shipped a rule that skipped the one break it had already
 * seen.
 */
export interface DeliveryAlertVerdict {
  /**
   * The event source whose deliveries stopped. Server-side only: it keys the
   * emailed alert's repeat window, so two broken sources behind one integration
   * each get their own. It is not on the wire, because the web has nothing to
   * do with it and carrying it there would put two slug spaces in one sentence.
   */
  source: EventSource;
  /** The integration whose connect flow restores deliveries. */
  integration: LiveProviderSlug;
  /** The one sentence the source's own health check gave, unedited. */
  reason: string;
}

/**
 * Every event source that stopped delivering for this user and that the user
 * can restore. Empty on a healthy account, which is the ordinary case.
 *
 * `rows` is the caller's own credential read. Both callers already hold one —
 * the integration-status join builds it, and the sweep reads the availability
 * snapshot — so this rule costs no query of its own.
 */
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
 * The live integrations that already carry a reconnect nag of their own: an
 * `active` credential row exists for the provider and no active row satisfies
 * the integration's connected rule (ADR-0093).
 *
 * That is the exact state `ScopeGapBanner` and `GithubReconnectBanner` render,
 * from the `providers[].missing` list on the same status body. They name the
 * same integration and offer the same click, so a delivery alert beside one of
 * them reads as two problems.
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

/** Gmail's integration slug, read off the event-source registry's account space. */
const GMAIL_INTEGRATION = eventDeliveryAccounts("gmail").integration;

/**
 * The integrations whose delivery repair this instance is forbidden from
 * performing, so an alert for one would ask the user to press a button that
 * cannot change anything.
 *
 * Gmail is the only one: its delivery repairs — reconnect the account, renew
 * the watch — are mailbox mutations gated by `gmailMailboxWritesEnabled()`
 * (ADR-0081). Off production that gate defaults off, so this instance never
 * installs a watch and every Gmail account reads `WATCH_NOT_INSTALLED`. The
 * verdict is honest, and workflow readiness must keep refusing the trigger, but
 * the absence is the environment's choice rather than a subscription that
 * lapsed. Suppress it here, at the surface rule, so readiness is untouched.
 */
function unrepairableHere(): ReadonlySet<LiveProviderSlug> {
  return gmailMailboxWritesEnabled() ? new Set() : new Set([GMAIL_INTEGRATION]);
}

/**
 * Project the alerts onto the wire, at most one per integration.
 *
 * One integration is one repair, so two broken sources behind it would ask the
 * user to press the same button twice. The first verdict wins, and the order is
 * the registry's, so the choice is stable across reads rather than dependent on
 * which health check answered first.
 *
 * A verdict that fails the wire schema is dropped, not carried. `reason` is a
 * bounded string on `deliveryAlertSchema`, and the web parses the whole status
 * body: one over-long sentence from a future descriptor would fail that parse
 * and blank every integration tile, which is the failure the field's
 * `.default([])` exists to prevent. One missing banner is the cheaper loss, and
 * the log names the descriptor that produced it.
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
