import {
  EVENT_SOURCES,
  isInboundEventSource,
  type EventSource,
  type EventSourceHealth,
  type EventSourceHealthMap,
  type InProcessEventSource,
  type IntegrationAvailabilitySnapshot,
} from "@alfred/contracts";
import {
  noSubscriptionHealthSignal,
  readInboundTriggerHealth,
} from "@alfred/assistant/connections/ingress";
import { readGmailEventHealth } from "./gmail-event-readiness";

type InProcessHealthReader = (
  userId: string,
  availability: IntegrationAvailabilitySnapshot,
  now: Date,
) => Promise<EventSourceHealth>;

/**
 * The in-process sources that have a delivery health reader. A source absent
 * here is healthy by construction: this process publishes its events, so there
 * is no subscription to lose. Only Gmail's push watch can break.
 */
const IN_PROCESS_HEALTH: ReadonlyMap<InProcessEventSource, InProcessHealthReader> = new Map<
  InProcessEventSource,
  InProcessHealthReader
>([["gmail", readGmailEventHealth]]);

const HEALTHY_BY_CONSTRUCTION: EventSourceHealth = { grain: "source", health: { healthy: true } };

/**
 * One delivery-health entry per `EventSource` for one user (#976, ADR-0097
 * item 5). Inbound sources come from their descriptors' `subscription.health`
 * at source grain; in-process sources come from the reader table above. A new
 * inbound source appears here with its descriptor and no edit to readiness.
 */
export async function readEventSourceHealth(
  userId: string,
  availability: IntegrationAvailabilitySnapshot,
  now: Date = new Date(),
): Promise<EventSourceHealthMap> {
  const inbound = readInboundTriggerHealth(userId);
  const entries = await Promise.all(
    EVENT_SOURCES.map(async (source): Promise<[EventSource, EventSourceHealth]> => {
      if (isInboundEventSource(source)) {
        const health = (await inbound).get(source) ?? noSubscriptionHealthSignal;
        return [source, { grain: "source", health }];
      }
      const reader = IN_PROCESS_HEALTH.get(source);
      return [source, reader ? await reader(userId, availability, now) : HEALTHY_BY_CONSTRUCTION];
    }),
  );
  return new Map(entries);
}
