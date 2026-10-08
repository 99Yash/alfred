import { isInboundEventSource, type InboundEventSource } from "@alfred/contracts";
import type { InboundSourceDescriptor } from "./descriptor";
import { githubInboundSource } from "./github";
import { sentryInboundSource } from "./sentry";

/** One descriptor per inbound source (ADR-0097). A missing, extra, or misfiled one does not compile. */
export const INBOUND_SOURCES = {
  github: githubInboundSource,
  sentry: sentryInboundSource,
} satisfies { readonly [S in InboundEventSource]: InboundSourceDescriptor<S> };

/** `null` when the route's `:source` is not an inbound source. */
export function inboundSource(slug: string): InboundSourceDescriptor | null {
  return isInboundEventSource(slug) ? INBOUND_SOURCES[slug] : null;
}
