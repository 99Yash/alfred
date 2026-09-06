import {
  INBOUND_EVENT_SOURCES,
  type EventDeliveryHealth,
  type InboundEventSource,
} from "@alfred/contracts";
import { INBOUND_SOURCES } from "./registry";

/**
 * The verdict for an inbound source whose descriptor has no `subscription`
 * adapter. Such a source reads as degraded, never quiet: the absence of
 * deliveries from it can never be reported as "nothing happened" (ADR-0097).
 */
export const noSubscriptionHealthSignal: EventDeliveryHealth = {
  healthy: false,
  reason: "no subscription health signal",
  recovery: { kind: "none" },
};

/**
 * Per-source subscription health for one user, for workflow trigger readiness
 * (ADR-0097). Every inbound source has an entry; `readEventSourceHealth` in
 * `automation/event-source-health.ts` folds them into the map keyed by every
 * `EventSource` (#976).
 */
export async function readInboundTriggerHealth(
  userId: string,
): Promise<ReadonlyMap<InboundEventSource, EventDeliveryHealth>> {
  const entries = await Promise.all(
    INBOUND_EVENT_SOURCES.map(async (slug): Promise<[InboundEventSource, EventDeliveryHealth]> => {
      const adapter = INBOUND_SOURCES[slug].subscription;
      return [slug, adapter ? await adapter.health(userId) : noSubscriptionHealthSignal];
    }),
  );
  return new Map(entries);
}
