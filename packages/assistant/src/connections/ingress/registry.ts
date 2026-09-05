import {
  INBOUND_EVENT_SOURCES,
  isInboundEventSource,
  type InboundEventSource,
} from "@alfred/contracts";
import type { InboundSourceDescriptor } from "./descriptor";
import { githubInboundSource } from "./github";

/**
 * Every inbound source descriptor, keyed by its contracts slug (ADR-0097). The
 * mapped type over `InboundEventSource` is the proof: an `inbound_webhook`
 * entry in `EVENT_SOURCE_ENTRIES` with no descriptor here, or a descriptor
 * whose slug the record does not declare, is a compile error.
 */
export const INBOUND_SOURCES = {
  github: githubInboundSource,
} satisfies { readonly [S in InboundEventSource]: InboundSourceDescriptor<S> };

// The type system proves the key set; these two facts it cannot see are
// asserted once, when the module loads, so a wrong descriptor fails boot.
for (const slug of INBOUND_EVENT_SOURCES) {
  const descriptor = INBOUND_SOURCES[slug];
  if (descriptor.slug !== slug) {
    throw new Error(`[ingress] descriptor under key '${slug}' declares slug '${descriptor.slug}'`);
  }
  if (
    "header" in descriptor.dedup &&
    descriptor.dedup.header !== descriptor.dedup.header.toLowerCase()
  ) {
    throw new Error(
      `[ingress] descriptor '${slug}' dedup header '${descriptor.dedup.header}' must be lowercase`,
    );
  }
}

/** The descriptor for one route `:source` segment, or `null` when the slug is not an inbound source. */
export function inboundSource(slug: string): InboundSourceDescriptor | null {
  return isInboundEventSource(slug) ? INBOUND_SOURCES[slug] : null;
}
