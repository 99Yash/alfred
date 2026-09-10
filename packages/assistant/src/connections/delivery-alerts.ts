import {
  isLiveProviderSlug,
  type DeliveryAlert,
  type InboundEventSource,
  type LiveProviderSlug,
} from "@alfred/contracts";
import { readDegradedInboundSources } from "./ingress";

/**
 * The alert surface rule for inbound delivery health (ADR-0100).
 *
 * A source that produces deliveries only while it is healthy cannot report its
 * own silence: it sends nothing when it breaks, so no push signal exists to
 * react to. Only a pull check answers the question. `readDegradedInboundSources`
 * is that pull read, and it answers a broader question than any surface should
 * print. This module is the one place that narrows the verdict to something
 * worth showing a person, so the banner and the emailed alert cannot disagree
 * about what counts.
 *
 * Two conditions, and a verdict must meet both:
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
 */
export interface InboundDeliveryAlert {
  /**
   * The inbound event source whose deliveries stopped. Server-side only: it
   * keys the emailed alert's repeat window, so two broken sources behind one
   * integration each get their own. It is not on the wire, because the web has
   * nothing to do with it and carrying it there would put two slug spaces in
   * one sentence.
   */
  source: InboundEventSource;
  /** The integration whose connect flow restores deliveries. */
  integration: LiveProviderSlug;
  /** The one sentence the source's own health check gave, unedited. */
  reason: string;
}

/**
 * Every inbound source that stopped delivering for this user and that the user
 * can restore. Empty on a healthy account, which is the ordinary case.
 */
export async function readInboundDeliveryAlerts(userId: string): Promise<InboundDeliveryAlert[]> {
  const degraded = await readDegradedInboundSources(userId);
  return degraded.flatMap((entry): InboundDeliveryAlert[] => {
    if (entry.recovery.kind !== "connect") return [];
    const { integration } = entry.recovery;
    if (!isLiveProviderSlug(integration)) return [];
    return [{ source: entry.slug, integration, reason: entry.reason }];
  });
}

/**
 * Project the alerts onto the wire, at most one per integration.
 *
 * One integration is one repair, so two broken sources behind it would ask the
 * user to press the same button twice. The first verdict wins, and the order is
 * the registry's, so the choice is stable across reads rather than dependent on
 * which health check answered first.
 */
export function toDeliveryAlerts(alerts: readonly InboundDeliveryAlert[]): DeliveryAlert[] {
  const seen = new Set<LiveProviderSlug>();
  const wire: DeliveryAlert[] = [];
  for (const alert of alerts) {
    if (seen.has(alert.integration)) continue;
    seen.add(alert.integration);
    wire.push({ integration: alert.integration, reason: alert.reason });
  }
  return wire;
}
