import type {
  CredentialRowsByProvider,
  EventTypeForSource,
  InboundEventSource,
  IntegrationSlug,
  JsonObject,
  IntegrationActivityItem,
} from "@alfred/contracts";

/**
 * The provider-specific half of one inbound webhook source (ADR-0097). A
 * descriptor owns exactly what differs between providers — how a delivery is
 * authenticated, how it is deduplicated, which event type it carries, and whose
 * account it belongs to, and how its receipts read as text. The shared receive path
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
   * Typed projection from the verified body and headers to one of three
   * verdicts: the event type a workflow may subscribe to; `raw` with the
   * provider's own kind, for a real delivery the entry does not name (stored
   * as a raw receipt, ADR-0097 item 9); or an explicit reason to ignore the
   * delivery outright (a `ping`, a body with no kind to read).
   */
  project(payload: JsonObject, headers: Headers): InboundProjection<S>;
  /** Describe a stored receipt; unknown kinds use the shared JSON fallback. */
  describe(kind: string, payload: unknown): InboundDescription;
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

export interface InboundDescription {
  title: string;
  summary: string;
  body: string;
  url?: string | undefined;
  status?: IntegrationActivityItem["status"] | undefined;
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
  /**
   * A verified delivery of a kind the entry does not declare. `rawKind` is the
   * provider's own name for it (`comment.created`, `issue_comment.created`),
   * kept verbatim: the inventory shows it, and a later typed promotion reads
   * it back. The receive path stores it keyed on the provider kind and payload hash with no
   * delivery job and no bus event.
   */
  | { kind: "raw"; rawKind: string }
  /** Nothing to keep: a ping, or a body that names no kind at all. */
  | { kind: "ignore"; reason: "ping" | "no-kind-header" };

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
 * Why deliveries from one source are not arriving (ADR-0100). Every unhealthy
 * verdict names one, because the three answer different questions and only one
 * of them is news:
 *
 * - `never_connected` — the user has not connected this source. Nothing broke,
 *   and nothing ever delivered. Workflow readiness still refuses a trigger
 *   armed on it, because such a trigger cannot fire; an alert surface must stay
 *   silent, because there is nothing to repair that the user did not choose.
 * - `broken` — the user connected this source and deliveries stopped. Only the
 *   user knows it used to work, so this is the one verdict an alert reports.
 * - `unknown` — Alfred holds no health signal for this source, so its silence
 *   proves nothing either way. Readiness treats it as degraded; no alert
 *   surface reports it, because "I cannot tell" is not a repair request.
 */
export type EventDeliveryCause = "never_connected" | "broken" | "unknown";

/**
 * One unhealthy verdict, as one arm per outcome that can actually occur.
 *
 * The cause and the recovery are not a free cross product. Two of the three
 * causes admit exactly one recovery, and a shape that let them vary would
 * compile a verdict no producer can mean: `{ cause: "unknown", recovery:
 * { kind: "connect" } }` claims that Alfred holds no signal and also knows the
 * repair, and `{ cause: "never_connected", recovery: { kind: "retry" } }`
 * claims that time restores a subscription nobody made. Pinning the recovery
 * per arm is what makes the compiler, rather than a paragraph, refuse those.
 *
 * Only `broken` keeps the full recovery vocabulary, and it needs all three: the
 * user reconnects a lapsed Gmail watch (`connect`), time restores a delivery
 * coverage gap (`retry`), and an operator sets a missing signing secret
 * (`none`).
 */
export type EventDeliveryFailure =
  | {
      healthy: false;
      /** Nothing was ever set up, so the one repair is the connect flow. */
      cause: "never_connected";
      reason: string;
      recovery: { kind: "connect"; integration: IntegrationSlug };
    }
  | {
      healthy: false;
      /** It worked and stopped. Who can restore it varies, so the recovery does. */
      cause: "broken";
      reason: string;
      recovery: EventDeliveryRecovery;
    }
  | {
      healthy: false;
      /** No signal at all, so no repair can be named. */
      cause: "unknown";
      reason: string;
      recovery: { kind: "none" };
    };

/**
 * Whether events from one source (or one account of it) will arrive. The one
 * verdict shape for every producer: inbound descriptors return it from
 * `subscription.health`, and the in-process readers in
 * `connections/event-source-health.ts` return it per source or per account.
 */
export type EventDeliveryHealth = { healthy: true } | EventDeliveryFailure;

/**
 * Provider-native health for the subscription that produces deliveries. It
 * answers for the user as a whole, which is why an inbound source is `source`
 * grain by type in `EVENT_SOURCE_ENTRIES`; a `connect` recovery names the
 * integration whose connect flow restores the subscription, because an event
 * source slug and an integration slug are different spaces.
 */
export interface InboundSubscriptionAdapter {
  /**
   * `rows` is the caller's own credential read, grouped by provider. An adapter
   * that answers from credential state reads it there instead of issuing its
   * own query, so the tile join and this verdict cannot disagree about which
   * rows exist, and the read the web polls gains no extra round trip. An
   * adapter whose question is not about this user's rows (Sentry attributes by
   * one shared signing secret across users) ignores it.
   */
  health(userId: string, rows: CredentialRowsByProvider): Promise<EventDeliveryHealth>;
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
