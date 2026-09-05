import { INBOUND_EVENT_SOURCES, type InboundEventSource } from "@alfred/contracts";
import type { InboundSubscriptionHealth } from "./descriptor";
import { INBOUND_SOURCES } from "./registry";

/**
 * Per-source subscription health for one user, for workflow trigger readiness
 * (ADR-0097). Every inbound source has an entry: a descriptor with no
 * `subscription` adapter reads as degraded, because the absence of deliveries
 * from such a source can never be reported as "nothing happened".
 */
export async function readInboundTriggerHealth(
  userId: string,
): Promise<ReadonlyMap<InboundEventSource, InboundSubscriptionHealth>> {
  const entries = await Promise.all(
    INBOUND_EVENT_SOURCES.map(
      async (slug): Promise<[InboundEventSource, InboundSubscriptionHealth]> => {
        const adapter = INBOUND_SOURCES[slug].subscription;
        if (!adapter) {
          return [
            slug,
            {
              healthy: false,
              reason: "no subscription health signal",
              recovery: { kind: "none" },
            },
          ];
        }
        return [slug, await adapter.health(userId)];
      },
    ),
  );
  return new Map(entries);
}
