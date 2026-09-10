import { INBOUND_EVENT_SOURCES, type InboundEventSource } from "@alfred/contracts";
import type { EventDeliveryFailure, EventDeliveryHealth } from "./descriptor";
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
 */
const NO_SUBSCRIPTION_HEALTH_SIGNAL: EventDeliveryHealth = {
  healthy: false,
  cause: "unknown",
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
 * One inbound source whose own subscription check reported it broken (#1035).
 * The verdict is the descriptor's, spread whole: derived from
 * {@link EventDeliveryFailure} rather than restated, so a field added to the
 * verdict reaches this reader and a field dropped here stops compiling.
 */
export type DegradedInboundSource = EventDeliveryFailure & { slug: InboundEventSource };

/**
 * The inbound sources that are broken right now, for one user (#1035).
 *
 * A source that produces deliveries only while it is healthy cannot report its
 * own silence, so only a pull check answers the question. This is that pull
 * read, and the per-source verdict stays the descriptor's own.
 *
 * `broken` is the whole filter, and it is read off the value (ADR-0100). A
 * source the user never connected is not broken, and a source with no adapter
 * is not a claim about delivery at all. Both are correct verdicts for workflow
 * readiness, which must refuse a trigger it cannot arm; neither is something a
 * user can repair, so neither reaches this list.
 *
 * The fold runs over {@link readInboundTriggerHealth}, so there is exactly one
 * place where a source becomes a verdict, and the two readers cannot drift.
 */
export async function readDegradedInboundSources(userId: string): Promise<DegradedInboundSource[]> {
  const health = await readInboundTriggerHealth(userId);
  return INBOUND_EVENT_SOURCES.flatMap((slug): DegradedInboundSource[] => {
    const verdict = health[slug];
    if (verdict.healthy || verdict.cause !== "broken") return [];
    return [{ slug, ...verdict }];
  });
}
