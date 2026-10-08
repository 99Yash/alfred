import type {
  CredentialRowsByProvider,
  EventTypeForSource,
  InboundEventSource,
  IntegrationSlug,
  JsonObject,
  IntegrationActivityItem,
} from "@alfred/contracts";

/**
 * The provider-specific half of one inbound webhook source (ADR-0097).
 * `ingestion/inbound-receive.ts` owns the step order, the receipt row, and the queue handoff.
 * A new source is one descriptor plus one `EVENT_SOURCE_ENTRIES` entry, never a new route.
 */
export interface InboundSourceDescriptor<S extends InboundEventSource = InboundEventSource> {
  slug: S;
  /** Check the raw body before any parse, in constant time. `false` means 401, nothing stored. */
  verify(raw: string, headers: Headers): boolean | Promise<boolean>;
  /** A delivery whose rule yields no key is acknowledged and dropped, never stored under a guessed key. */
  dedup: InboundDedupRule<S>;
  /** A declared event type, `raw` for a kind the entry does not name (ADR-0097 item 9), or ignore. */
  project(payload: JsonObject, headers: Headers): InboundProjection<S>;
  /** Describe a stored receipt; unknown kinds use the shared JSON fallback. */
  describe(kind: string, payload: unknown): InboundDescription;
  /** An `unowned` delivery is dropped and reported (ADR-0097 alternative e). */
  resolveOwner(payload: JsonObject, headers: Headers): Promise<InboundAttribution>;
  /** Without one, readiness reads the source as degraded: its silence proves nothing. */
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
 * `key` is a method, not a function property, so it is checked bivariantly.
 * Otherwise `InboundSourceDescriptor<"sentry">` would not widen to the union type.
 */
export type InboundDedupRule<S extends InboundEventSource = InboundEventSource> =
  /** A header id that is stable across redeliveries (GitHub's `X-GitHub-Delivery`). */
  | { kind: "delivery_id"; header: string }
  /** A key from the payload. `null` means the payload lacks the identity the rule reads. */
  | { kind: "synthetic"; key(input: InboundKeyInput<S>): string | null }
  /** Prefer the header; fall back to the payload key when the header is absent. */
  | {
      kind: "delivery_id_or_synthetic";
      header: string;
      key(input: InboundKeyInput<S>): string | null;
    };

/** What a synthetic key may read. No headers: the type already names the resource. */
export interface InboundKeyInput<S extends InboundEventSource = InboundEventSource> {
  payload: JsonObject;
  type: EventTypeForSource<S>;
  /** sha256 of the raw body, as in `event_receipts.payload_hash`. For providers that reuse an identity. */
  payloadHash: string;
}

/** The annotation type for a synthetic key function. */
export type InboundSyntheticKey<S extends InboundEventSource = InboundEventSource> = (
  input: InboundKeyInput<S>,
) => string | null;

export type InboundProjection<S extends InboundEventSource> =
  | { kind: "event"; type: EventTypeForSource<S> }
  /** A verified kind the entry does not declare. `rawKind` is the provider's name, kept verbatim. */
  | { kind: "raw"; rawKind: string }
  | { kind: "ignore"; reason: "ping" | "no-kind-header" };

export interface InboundOwner {
  userId: string;
  credentialId: string;
  /** `integration_credentials.account_id`. */
  accountRef: string;
}

/** The provider id an unowned payload named, and the credential column it matches. */
export interface UnattributedReference {
  column: "account_id" | "installation_id";
  value: string;
}

/**
 * `ambiguous`: more than one active credential behind one shared secret (Sentry).
 * `reference` tells an operator if a credential is missing or stale.
 * It is `null` when the payload names no account.
 */
export type InboundAttribution =
  | { kind: "owned"; owner: InboundOwner }
  | { kind: "unowned"; reason: "no_match" | "ambiguous"; reference: UnattributedReference | null };

/** What restores deliveries. Event source slugs and integration slugs differ, so `connect` names the integration. */
export type EventDeliveryRecovery =
  | { kind: "connect"; integration: IntegrationSlug }
  | { kind: "retry" }
  /** Only time or an operator can restore deliveries. */
  | { kind: "none" };

/**
 * Why deliveries are not arriving (ADR-0100). Only `broken` raises an alert.
 * `never_connected` and `unknown` still fail workflow readiness.
 */
export type EventDeliveryCause = "never_connected" | "broken" | "unknown";

/** Each cause pins the recoveries it allows, so nonsense pairs do not compile. */
export type EventDeliveryFailure =
  | {
      healthy: false;
      cause: "never_connected";
      reason: string;
      recovery: { kind: "connect"; integration: IntegrationSlug };
    }
  | {
      healthy: false;
      cause: "broken";
      reason: string;
      recovery: EventDeliveryRecovery;
    }
  | {
      healthy: false;
      cause: "unknown";
      reason: string;
      recovery: { kind: "none" };
    };

/** Whether events from one source, or one account of it, will arrive. */
export type EventDeliveryHealth = { healthy: true } | EventDeliveryFailure;

/** Provider-native subscription health, for the user as a whole. */
export interface InboundSubscriptionAdapter {
  /** Read credentials from `rows`, not a new query, so this verdict and the tile agree. */
  health(userId: string, rows: CredentialRowsByProvider): Promise<EventDeliveryHealth>;
}

/** The typed event type, or the raw kind on the raw tier. */
export function projectionKind(
  projection: Exclude<InboundProjection<InboundEventSource>, { kind: "ignore" }>,
): string {
  return projection.kind === "raw" ? projection.rawKind : projection.type;
}

/** The dedup key for one delivery, or `null`. */
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
