import { INBOUND_EVENT_SOURCES, type InboundEventSource } from "@alfred/contracts";
import type { EventDeliveryHealth, EventDeliveryRecovery } from "./descriptor";
import { INBOUND_SOURCES } from "./registry";

/**
 * The verdict for an inbound source whose descriptor has no `subscription`
 * adapter. Such a source reads as degraded, never quiet: the absence of
 * deliveries from it can never be reported as "nothing happened" (ADR-0097).
 */
const NO_SUBSCRIPTION_HEALTH_SIGNAL: EventDeliveryHealth = {
  healthy: false,
  reason: "no subscription health signal",
  recovery: { kind: "none" },
};

/**
 * Per-source subscription health for one user, for workflow trigger readiness
 * (ADR-0097). The record holds every inbound source, so the one consumer,
 * `readEventSourceHealth` in `automation/event-source-health.ts`, folds it into
 * the map keyed by every `EventSource` without a fallback (#976).
 */
export async function readInboundTriggerHealth(
  userId: string,
): Promise<Readonly<Record<InboundEventSource, EventDeliveryHealth>>> {
  const entries = await Promise.all(
    INBOUND_EVENT_SOURCES.map(async (slug): Promise<[InboundEventSource, EventDeliveryHealth]> => {
      const adapter = INBOUND_SOURCES[slug].subscription;
      return [slug, adapter ? await adapter.health(userId) : NO_SUBSCRIPTION_HEALTH_SIGNAL];
    }),
  );
  // SAFETY: `Object.fromEntries` types its keys as `string`; the pairs are built
  // from INBOUND_EVENT_SOURCES, so the keys are exactly InboundEventSource.
  return Object.fromEntries(entries) as Record<InboundEventSource, EventDeliveryHealth>;
}

/**
 * One inbound source that its own subscription check reported broken (#1035).
 * `reason` and `recovery` come from the descriptor verbatim, so the caller
 * never restates a per-source rule.
 */
export interface DegradedInboundSource {
  slug: InboundEventSource;
  reason: string;
  recovery: EventDeliveryRecovery;
}

/**
 * The inbound sources that are broken right now, for one user (#1035).
 *
 * A source that produces deliveries only while it is healthy cannot report its
 * own silence, so only a pull check answers the question. This is that pull
 * read: the scheduled reconciler in the briefing gather calls it, and the
 * per-source verdict stays the descriptor's own.
 *
 * A descriptor that declares no `subscription` adapter is skipped, not
 * reported. Trigger readiness reads such a source as degraded on purpose —
 * silence from it proves nothing — but that verdict is a statement about what
 * Alfred can know, not a broken subscription a user can repair, so it is not a
 * line worth a briefing.
 */
export async function readDegradedInboundSources(userId: string): Promise<DegradedInboundSource[]> {
  const verdicts = await Promise.all(
    INBOUND_EVENT_SOURCES.map(async (slug): Promise<DegradedInboundSource[]> => {
      const adapter = INBOUND_SOURCES[slug].subscription;
      if (!adapter) return [];
      const health = await adapter.health(userId);
      return health.healthy ? [] : [{ slug, reason: health.reason, recovery: health.recovery }];
    }),
  );
  return verdicts.flat();
}
