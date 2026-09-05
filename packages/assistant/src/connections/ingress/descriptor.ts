import type {
  EventTypeForSource,
  InboundEventSource,
  IntegrationSlug,
  JsonObject,
} from "@alfred/contracts";

/**
 * The provider-specific half of one inbound webhook source (ADR-0097). A
 * descriptor owns exactly what differs between providers — how a delivery is
 * authenticated, how it is deduplicated, which event type it carries, and whose
 * account it belongs to — and nothing else. The shared receive path
 * (`receive.ts`) owns the order of those steps, the receipt row, and the
 * handoff to the queue, so a new source is one descriptor and one entry in
 * `EVENT_SOURCE_ENTRIES`, never a new route.
 *
 * `S` ties the descriptor to its contracts entry: `project` may only return an
 * event type that entry declares, and the registry in `registry.ts` is keyed
 * `Record<InboundEventSource, InboundSourceDescriptor<S>>`, so an entry without
 * a descriptor, or a descriptor without an entry, fails to compile.
 */
export interface InboundSourceDescriptor<S extends InboundEventSource = InboundEventSource> {
  /** The registry key; `S` pins it to the `EVENT_SOURCE_ENTRIES` key the descriptor is filed under. */
  slug: S;
  /**
   * Authenticate one delivery over the RAW request body and its headers,
   * before any parse. Must compare in constant time. `false` rejects the
   * delivery with 401 and stores nothing.
   */
  verify(raw: string, headers: Headers): boolean | Promise<boolean>;
  /**
   * How two deliveries of the same provider event are recognized. Required: a
   * source that has no stable delivery id must say so by declaring a synthetic
   * key over the payload, and a source that declares neither does not compile.
   * A delivery whose rule yields no key is acknowledged and dropped, never
   * stored under a guessed key.
   */
  dedup: InboundDedupRule;
  /**
   * Typed projection from the verified body and headers to the event type a
   * workflow may subscribe to, or an explicit reason to ignore the delivery
   * (a `ping`, an event the source does not subscribe to).
   */
  project(payload: JsonObject, headers: Headers): InboundProjection<S>;
  /** Resolve the credential that owns the delivery; `null` means unattributable. */
  resolveOwner(payload: JsonObject, headers: Headers): Promise<InboundOwner | null>;
  /**
   * Optional provider-native health signal for the subscription that produces
   * deliveries. A descriptor without one reads as degraded in trigger
   * readiness, because silence from such a source cannot be told apart from a
   * broken subscription.
   */
  subscription?: InboundSubscriptionAdapter;
}

export type InboundDedupRule =
  /** The provider sends a delivery id that is stable across redeliveries (GitHub's `X-GitHub-Delivery`). */
  | { kind: "delivery_id"; header: string }
  /**
   * No stable id on the wire: the key is derived from payload identity. The
   * headers are passed too, because a provider may name the resource only
   * there (Sentry's `Sentry-Hook-Resource`). `null` = cannot key this delivery.
   */
  | { kind: "synthetic"; key: InboundSyntheticKey }
  /** Prefer the header; fall back to the payload key when the header is absent. */
  | { kind: "delivery_id_or_synthetic"; header: string; key: InboundSyntheticKey };

export type InboundSyntheticKey = (payload: JsonObject, headers: Headers) => string | null;

export type InboundProjection<S extends InboundEventSource> =
  | { kind: "event"; type: EventTypeForSource<S> }
  | { kind: "ignore"; reason: string };

export interface InboundOwner {
  userId: string;
  credentialId: string;
  /** The provider account id, carried on the domain event as `accountRef`. */
  accountRef: string;
}

/**
 * The user action that can restore deliveries. `connect` names the integration
 * whose connect flow restores the subscription: an event source slug and an
 * integration slug are different spaces, so the descriptor says which one, and
 * readiness never guesses from the source name.
 */
export type InboundSubscriptionRecovery =
  | { kind: "connect"; integration: IntegrationSlug }
  | { kind: "retry" }
  /** Only time or an operator can restore deliveries. */
  | { kind: "none" };

export type InboundSubscriptionHealth =
  | { healthy: true }
  | { healthy: false; reason: string; recovery: InboundSubscriptionRecovery };

export interface InboundSubscriptionAdapter {
  health(userId: string): Promise<InboundSubscriptionHealth>;
}

/** Resolve the dedup key one rule yields for one delivery, or `null` when it yields none. */
export function inboundDeliveryKey(
  rule: InboundDedupRule,
  payload: JsonObject,
  headers: Headers,
): string | null {
  switch (rule.kind) {
    case "delivery_id":
      return nonEmpty(headers.get(rule.header));
    case "synthetic":
      return nonEmpty(rule.key(payload, headers));
    case "delivery_id_or_synthetic":
      return nonEmpty(headers.get(rule.header)) ?? nonEmpty(rule.key(payload, headers));
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

function nonEmpty(value: string | null): string | null {
  return value && value.trim().length > 0 ? value : null;
}
