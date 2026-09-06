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
  dedup: InboundDedupRule<S>;
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

/**
 * `key` is a method signature, not a function-typed property, on purpose. The
 * registry stores `InboundSourceDescriptor<"sentry">` behind the union-typed
 * `InboundSourceDescriptor`, and a property whose parameter narrows with `S`
 * would not be assignable under strict function variance; a method is checked
 * bivariantly. The receive path only ever calls a rule with the type its own
 * descriptor projected, so the widening is sound in practice.
 */
export type InboundDedupRule<S extends InboundEventSource = InboundEventSource> =
  /** The provider sends a delivery id that is stable across redeliveries (GitHub's `X-GitHub-Delivery`). */
  | { kind: "delivery_id"; header: string }
  /**
   * No stable id on the wire: the key is derived from payload identity. The
   * key receives the projected event type and switches on it exhaustively, so
   * a type the entry subscribes to without a key rule does not compile. `null`
   * = the payload lacks the identity the rule reads.
   */
  | { kind: "synthetic"; key(input: InboundKeyInput<S>): string | null }
  /** Prefer the header; fall back to the payload key when the header is absent. */
  | {
      kind: "delivery_id_or_synthetic";
      header: string;
      key(input: InboundKeyInput<S>): string | null;
    };

/** What a synthetic key may read. The headers are absent on purpose: the type already names the resource. */
export interface InboundKeyInput<S extends InboundEventSource = InboundEventSource> {
  payload: JsonObject;
  /** The type `project` returned for this delivery; the key switches on it. */
  type: EventTypeForSource<S>;
  /**
   * sha256 hex of the raw body, the same value `event_receipts.payload_hash`
   * stores. A key may fold a slice of it in when the provider repeats an
   * identity for distinct events and offers no other fact to tell them apart.
   */
  payloadHash: string;
}

/** The function type a descriptor author annotates a synthetic key with; the rule stores it as a method. */
export type InboundSyntheticKey<S extends InboundEventSource = InboundEventSource> = (
  input: InboundKeyInput<S>,
) => string | null;

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
 * The user action that can restore deliveries from one event source. `connect`
 * names the integration whose connect flow restores the subscription: an event
 * source slug and an integration slug are different spaces, so the health
 * reader says which one, and readiness never guesses from the source name.
 */
export type EventDeliveryRecovery =
  | { kind: "connect"; integration: IntegrationSlug }
  | { kind: "retry" }
  /** Only time or an operator can restore deliveries. */
  | { kind: "none" };

/**
 * Whether events from one source (or one account of it) will arrive. The one
 * verdict shape for every producer: inbound descriptors return it from
 * `subscription.health`, and the in-process readers in
 * `automation/event-source-health.ts` return it per source or per account.
 */
export type EventDeliveryHealth =
  | { healthy: true }
  | { healthy: false; reason: string; recovery: EventDeliveryRecovery };

/**
 * Provider-native health for the subscription that produces deliveries. It
 * answers for the user as a whole, which is why an inbound source is `source`
 * grain by type in `EVENT_SOURCE_ENTRIES`; a `connect` recovery names the
 * integration whose connect flow restores the subscription, because an event
 * source slug and an integration slug are different spaces.
 */
export interface InboundSubscriptionAdapter {
  health(userId: string): Promise<EventDeliveryHealth>;
}

/** Resolve the dedup key one rule yields for one delivery, or `null` when it yields none. */
export function inboundDeliveryKey<S extends InboundEventSource>(
  rule: InboundDedupRule<S>,
  headers: Headers,
  input: InboundKeyInput<S>,
): string | null {
  switch (rule.kind) {
    case "delivery_id":
      return nonEmpty(headers.get(rule.header));
    case "synthetic":
      return nonEmpty(rule.key(input));
    case "delivery_id_or_synthetic":
      return nonEmpty(headers.get(rule.header)) ?? nonEmpty(rule.key(input));
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

function nonEmpty(value: string | null): string | null {
  return value && value.trim().length > 0 ? value : null;
}
