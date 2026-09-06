import { INBOUND_EVENT_SOURCES, type InboundEventSource } from "@alfred/contracts";
import type { EventDeliveryHealth } from "./descriptor";
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
