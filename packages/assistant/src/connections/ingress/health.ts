import {
  INBOUND_EVENT_SOURCES,
  type CredentialRowsByProvider,
  type InboundEventSource,
} from "@alfred/contracts";
import type { EventDeliveryHealth } from "./descriptor";
import { INBOUND_SOURCES } from "./registry";

/** No adapter means degraded, never quiet (ADR-0097, ADR-0100). No current descriptor reaches it. */
const NO_SUBSCRIPTION_HEALTH_SIGNAL: EventDeliveryHealth = {
  healthy: false,
  cause: "unknown",
  reason: "no subscription health signal",
  recovery: { kind: "none" },
};

/** Subscription health for every inbound source (ADR-0097). `rows` is the caller's credential read. */
export async function readInboundTriggerHealth(
  userId: string,
  rows: CredentialRowsByProvider,
): Promise<Readonly<Record<InboundEventSource, EventDeliveryHealth>>> {
  const entries = await Promise.all(
    INBOUND_EVENT_SOURCES.map(async (slug): Promise<[InboundEventSource, EventDeliveryHealth]> => {
      const adapter = INBOUND_SOURCES[slug].subscription;

      return [slug, adapter ? await adapter.health(userId, rows) : NO_SUBSCRIPTION_HEALTH_SIGNAL];
    }),
  );

  // SAFETY: the keys come from INBOUND_EVENT_SOURCES.
  return Object.fromEntries(entries) as Record<InboundEventSource, EventDeliveryHealth>;
}
