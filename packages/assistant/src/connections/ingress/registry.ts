import { isInboundEventSource, type InboundEventSource } from "@alfred/contracts";
import type { InboundSourceDescriptor } from "./descriptor";
import { githubInboundSource } from "./github";
import { sentryInboundSource } from "./sentry";

/**
 * Every inbound source descriptor, keyed by its contracts slug (ADR-0097). The
 * mapped type over `InboundEventSource` is the whole proof: an `inbound_webhook`
 * entry in `EVENT_SOURCE_ENTRIES` with no descriptor here, a descriptor whose
 * slug the record does not declare, and a descriptor filed under the wrong key
 * (`InboundSourceDescriptor<S>` pins `slug: S`) are all compile errors.
 */
export const INBOUND_SOURCES = {
  github: githubInboundSource,
  sentry: sentryInboundSource,
} satisfies { readonly [S in InboundEventSource]: InboundSourceDescriptor<S> };

/** The descriptor for one route `:source` segment, or `null` when the slug is not an inbound source. */
export function inboundSource(slug: string): InboundSourceDescriptor | null {
  return isInboundEventSource(slug) ? INBOUND_SOURCES[slug] : null;
}
