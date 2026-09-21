import {
  INBOUND_EVENT_SOURCES,
  type CredentialRowsByProvider,
  type InboundEventSource,
} from "@alfred/contracts";
import type { EventDeliveryHealth } from "./descriptor";
import { INBOUND_SOURCES } from "./registry";

/**
 * The verdict for an inbound source whose descriptor has no `subscription`
 * adapter. Such a source reads as degraded, never quiet: the absence of
 * deliveries from it can never be reported as "nothing happened" (ADR-0097).
 *
 * `cause: "unknown"` is what makes that statement readable from the value
 * (ADR-0100). Before it, this sentinel was shape-identical to a real broken
 * verdict, so a second reader had to re-derive "the descriptor declares no
 * adapter" from the registry — two folds over the same registry that answered
 * the no-adapter case oppositely, held together by a comment.
 *
 * No descriptor reaches it today: both `github` and `sentry` declare an
 * adapter. It is the verdict the next descriptor gets for free, and the reason
 * a descriptor may leave `subscription` off at all.
 */
const NO_SUBSCRIPTION_HEALTH_SIGNAL: EventDeliveryHealth = {
  healthy: false,
  cause: "unknown",
  reason: "no subscription health signal",
  recovery: { kind: "none" },
};

/**
 * Per-source subscription health for one user (ADR-0097). The record holds
 * every inbound source, so the one consumer, `readEventSourceHealth` in
 * `connections/event-source-health.ts`, folds it into the map keyed by every
 * `EventSource` without a fallback (#976).
 *
 * `rows` is the caller's credential read. An adapter that answers from
 * credential state reads it instead of issuing its own query, so this fold adds
 * no round trip to the read that carries it.
 */
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

  // SAFETY: `Object.fromEntries` types its keys as `string`; the pairs are built
  // from INBOUND_EVENT_SOURCES, so the keys are exactly InboundEventSource.
  return Object.fromEntries(entries) as Record<InboundEventSource, EventDeliveryHealth>;
}
