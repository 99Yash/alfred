import { enumGuard } from "./guards";
import {
  INTEGRATIONS,
  credentialProviderOf,
  type CredentialProvider,
  type CredentialSpec,
  type LiveProviderSlug,
} from "./integrations";

/**
 * The grain at which one source's deliveries can break (#976).
 *
 * - `source`: one delivery verdict per user. An inbound webhook whose owner is
 *   one installation or organization (GitHub App, Sentry) reads this way, and
 *   so does an in-process source with no subscription to lose.
 * - `account`: one verdict per connected account of `integration`. The rows a
 *   trigger's `accountRef` resolves against are the integration's credential
 *   rows that satisfy its connected rule, so the account space is declared
 *   once here and read through {@link eventDeliveryAccounts}. Gmail's
 *   per-account push watch reads this way.
 */
export type EventDeliveryGrain =
  | { grain: "source" }
  | { grain: "account"; integration: LiveProviderSlug };

interface EventSourceEntryBase {
  eventTypes: readonly [string, ...string[]];
}

/**
 * The browser-safe half of one event source: how its domain events are
 * produced, at which grain their delivery can break, and which event types a
 * workflow may subscribe to.
 *
 * - `in_process`: the source's domain events are published by code inside the
 *   server (an ingestion worker, an OAuth callback, a workflow's terminal step).
 * - `inbound_webhook`: the source's domain events arrive as HTTP deliveries on
 *   `POST /webhooks/inbound/:source`. Every such source has an
 *   `InboundSourceDescriptor` in `@alfred/assistant/connections/ingress`, and the
 *   descriptor registry is typed `Record<InboundEventSource, …>`, so adding a
 *   source here without a descriptor there fails to compile (and vice versa).
 *   The descriptor's `subscription.health` answers for the user as a whole, so
 *   an inbound source is `source` grain by type; a per-account inbound source
 *   needs a new adapter shape before this union admits it.
 */
export type EventSourceEntry =
  | (EventSourceEntryBase & { producer: "in_process"; delivery: EventDeliveryGrain })
  | (EventSourceEntryBase & { producer: "inbound_webhook"; delivery: { grain: "source" } });

/**
 * Every domain-event source, keyed by slug (ADR-0047, ADR-0097). The record's
 * keys are the source space: `EventSource` is `keyof` this object, and every
 * per-source table elsewhere is a projection of it or keyed
 * `satisfies Record<EventSource, …>` on a union it derives.
 */
export const EVENT_SOURCE_ENTRIES = {
  gmail: {
    producer: "in_process",
    // One Pub/Sub watch per connected Google account; the watch can lapse per account.
    delivery: { grain: "account", integration: "gmail" },
    eventTypes: ["message_received", "documents_ingested"],
  },
  "google.oauth.callback": {
    producer: "in_process",
    delivery: { grain: "source" },
    eventTypes: ["completed"],
  },
  "learn-skill": {
    producer: "in_process",
    delivery: { grain: "source" },
    eventTypes: ["completed"],
  },
  github: {
    producer: "inbound_webhook",
    delivery: { grain: "source" },
    // Mirrors the GitHub App's subscribed `default_events`.
    eventTypes: ["pull_request", "push", "issues", "pull_request_review"],
  },
  /**
   * Sentry internal-integration webhooks, one type per `<resource>_<action>`
   * pair the descriptor subscribes to (`Sentry-Hook-Resource` header plus the
   * body's `action`). `error_created` is plan-gated on Sentry's side
   * (Business+); `event_alert_triggered` is the per-project alert-rule route
   * every plan has; the `issue_*` set is the lifecycle fallback; and
   * `seer_pr_created` is the Seer Autofix pull request the verification rung
   * consumes (#563, #567).
   */
  sentry: {
    producer: "inbound_webhook",
    delivery: { grain: "source" },
    eventTypes: [
      "error_created",
      "event_alert_triggered",
      "issue_created",
      "issue_resolved",
      "issue_unresolved",
      "issue_assigned",
      "issue_archived",
      "seer_pr_created",
    ],
  },
  /**
   * `classified` is the fact the triage `classify` step publishes for every thread
   * whose row it owns; the reply-drafting gate consumes it (ADR-0098). `reply_worthy`
   * is the trigger the `reply-drafting` builtin declares. Nothing publishes it on
   * the bus: the gate starts the run directly, so a worthy verdict is the only
   * thing that can fire the workflow, and the declaration still names its cause.
   */
  "email-triage": {
    producer: "in_process",
    delivery: { grain: "source" },
    eventTypes: ["classified", "reply_worthy"],
  },
} as const satisfies Record<string, EventSourceEntry>;

export type EventSource = keyof typeof EVENT_SOURCE_ENTRIES;
export type EventSourceEntryOf<S extends EventSource> = (typeof EVENT_SOURCE_ENTRIES)[S];

/** The sources in record order. */
export const EVENT_SOURCES: readonly EventSource[] =
  // SAFETY: `Object.keys` types its result as `string[]`; the keys of a
  // non-indexed literal are exactly `keyof typeof EVENT_SOURCE_ENTRIES`.
  Object.keys(EVENT_SOURCE_ENTRIES) as EventSource[];

export const isEventSource = enumGuard(EVENT_SOURCES);

/** The sources whose entry extends `P`. */
export type EventSourcesWhere<P> = {
  [S in EventSource]: EventSourceEntryOf<S> extends P ? S : never;
}[EventSource];

export type InboundEventSource = EventSourcesWhere<{ producer: "inbound_webhook" }>;
export type InProcessEventSource = EventSourcesWhere<{ producer: "in_process" }>;
/** The sources whose delivery breaks per connected account, not per user. */
export type AccountGrainEventSource = EventSourcesWhere<{ delivery: { grain: "account" } }>;

export const INBOUND_EVENT_SOURCES: readonly InboundEventSource[] = EVENT_SOURCES.filter(
  (source): source is InboundEventSource =>
    EVENT_SOURCE_ENTRIES[source].producer === "inbound_webhook",
);
export const isInboundEventSource = enumGuard(INBOUND_EVENT_SOURCES);

export type EventTypeForSource<S extends EventSource> = EventSourceEntryOf<S>["eventTypes"][number];

export type EventType = {
  [S in EventSource]: EventTypeForSource<S>;
}[EventSource];

/** Per-source event-type tuples, projected off the record for table-shaped readers. */
export const EVENT_TYPES_BY_SOURCE: {
  readonly [S in EventSource]: EventSourceEntryOf<S>["eventTypes"];
} =
  // SAFETY: `Object.fromEntries` types its result as `{ [k: string]: T }`; the
  // pairs are built from EVENT_SOURCES, so the keys are exactly EventSource and
  // each value is that source's own `eventTypes` tuple.
  Object.fromEntries(
    EVENT_SOURCES.map((source) => [source, EVENT_SOURCE_ENTRIES[source].eventTypes]),
  ) as { [S in EventSource]: EventSourceEntryOf<S>["eventTypes"] };

export const EVENT_TYPES =
  // SAFETY: every element comes from EVENT_SOURCE_ENTRIES's per-source const
  // tuples, whose members are exactly the EventType literals; Set only
  // dedupes (several sources share `completed`), so the frozen array is a
  // readonly EventType[].
  Object.freeze([
    ...new Set(EVENT_SOURCES.flatMap((source) => EVENT_SOURCE_ENTRIES[source].eventTypes)),
  ]) as readonly EventType[];

export const isEventType = enumGuard(EVENT_TYPES);

export function isEventTypeForSource<S extends EventSource>(
  source: S,
  value: string,
): value is EventTypeForSource<S> {
  // SAFETY: the per-source row is a const tuple of that source's event-type
  // literals; widening to readonly string[] only types the .includes receiver
  // for the runtime membership test this guard performs.
  return (EVENT_SOURCE_ENTRIES[source].eventTypes as readonly string[]).includes(value);
}

/**
 * The `<source>.<type>` name one domain event is stored and logged under: the
 * `event_receipts.event_type` column, the workflow trigger label, the log line.
 * One writer and one reader, so the two never agree on the dot by convention.
 */
export function eventTypeName<S extends EventSource>(
  source: S,
  type: EventTypeForSource<S>,
): `${S}.${EventTypeForSource<S>}` {
  return `${source}.${type}`;
}

/**
 * The `type` half of a raw receipt's `event_type` (ADR-0097 item 9). A raw
 * receipt is a verified delivery whose kind the source's entry does not name;
 * it is stored under `<source>.raw` and carries the provider's own kind in
 * `event_receipts.raw_kind`. The marker is not a member of any entry's
 * `eventTypes` tuple, so `parseEventTypeName` reads a raw row as `null` and no
 * typed reader can mistake it for a subscribed event.
 *
 * The marker, or `never` the day an entry declares `raw` as an event type. In
 * that case `rawEventTypeName` no longer compiles, which is the gate: a typed
 * `raw` would make every stored raw row read back as a subscribed event.
 */
export type RawReceiptType = "raw" extends EventType ? never : "raw";

/**
 * The raw marker as a value (#990). A user-authored trigger whose `type` is
 * this marker subscribes to one raw kind of an inbound source, named in its
 * `rawKind`; the deliver job publishes a raw receipt under the same marker.
 */
export const RAW_EVENT_TYPE: RawReceiptType = "raw";

export function isRawEventType(value: string): value is RawReceiptType {
  return value === RAW_EVENT_TYPE;
}

/** The `event_type` a raw receipt of `source` is stored under. */
export function rawEventTypeName<S extends InboundEventSource>(
  source: S,
): `${S}.${RawReceiptType}` {
  return `${source}.${RAW_EVENT_TYPE}`;
}

/**
 * The sources a user may subscribe a workflow to (ADR-0097 item 6, #990). A
 * curated subset of `EVENT_SOURCES`: the internal sources
 * (`google.oauth.callback`, `learn-skill`, `email-triage`) drive built-in flows
 * and are not authorable. Gmail is authorable on its typed events; the inbound
 * sources are authorable on a raw kind their inventory has seen, so a new
 * provider resource becomes a trigger the day it first arrives, with no code edit.
 */
export const AUTHORABLE_EVENT_SOURCES = [
  "gmail",
  "github",
  "sentry",
] as const satisfies readonly EventSource[];
export type AuthorableEventSource = (typeof AUTHORABLE_EVENT_SOURCES)[number];
export const isAuthorableEventSource = enumGuard(AUTHORABLE_EVENT_SOURCES);

/**
 * The authorable sources whose declared (typed) event types a user may name.
 * The inbound sources are deliberately absent: their typed kinds keep their
 * built-in consumers and dedup rules, and a user reaches them only through the
 * raw tier (#990 keeps typed triggers unchanged).
 */
export const AUTHORABLE_TYPED_EVENT_SOURCES = ["gmail"] as const satisfies readonly EventSource[];

export interface AuthorableEventTriggerIssue {
  path: "source" | "type" | "rawKind";
  message: string;
}

/**
 * The raw-tier shape rule for any event trigger (#990): `type: "raw"` needs an
 * inbound source and a `rawKind`; every other type must leave `rawKind` unset.
 * Shared by the authoring rule below and the server's definition validator, so
 * a stored trigger and an authored one obey one rule.
 */
export function rawEventTriggerIssue(trigger: {
  source: EventSource;
  type: string;
  rawKind?: string | undefined;
}): AuthorableEventTriggerIssue | null {
  if (isRawEventType(trigger.type)) {
    if (!isInboundEventSource(trigger.source)) {
      return {
        path: "type",
        message: `'${trigger.source}' has no raw event kinds; name one of its event types`,
      };
    }
    if (!trigger.rawKind) {
      return { path: "rawKind", message: "A raw event trigger must name the provider kind" };
    }
    return null;
  }
  if (trigger.rawKind !== undefined) {
    return { path: "rawKind", message: "rawKind is only valid with type 'raw'" };
  }
  return null;
}

/**
 * The one structural rule for a user-authored event trigger, shared by the
 * editor mutator schema (`@alfred/sync`) and the chat authoring schema here so
 * the two surfaces cannot drift (#990).
 *
 * - `type === "raw"`: the source must be an inbound source and `rawKind` must
 *   name the provider kind. Whether the source has seen that kind is a database
 *   fact the revision service checks; this rule is the pure half.
 * - any other `type`: the source must be a typed-authorable source, the type
 *   must be one its entry declares, and `rawKind` must be absent.
 */
export function authorableEventTriggerIssue(trigger: {
  source: AuthorableEventSource;
  type: string;
  rawKind?: string | undefined;
}): AuthorableEventTriggerIssue | null {
  const tierIssue = rawEventTriggerIssue(trigger);
  if (tierIssue) return tierIssue;
  if (isRawEventType(trigger.type)) return null;
  // SAFETY: the tuple is a const list of EventSource literals; widening to
  // readonly string[] only types the .includes receiver for this membership test.
  if (!(AUTHORABLE_TYPED_EVENT_SOURCES as readonly string[]).includes(trigger.source)) {
    return {
      path: "type",
      message: `'${trigger.source}' triggers use type 'raw' with a rawKind the integration has delivered`,
    };
  }
  if (!isEventTypeForSource(trigger.source, trigger.type)) {
    return {
      path: "type",
      message: `'${trigger.type}' is not a valid event type for '${trigger.source}'`,
    };
  }
  return null;
}

/**
 * Read the `type` half back out of a stored `<source>.<type>` name for a known
 * source, or `null` when the name is not one that source declares. Sources
 * contain dots (`google.oauth.callback`), so the caller names the source and
 * this strips exactly that prefix.
 */
export function parseEventTypeName<S extends EventSource>(
  source: S,
  name: string,
): EventTypeForSource<S> | null {
  const prefix = `${source}.`;
  if (!name.startsWith(prefix)) return null;
  const type = name.slice(prefix.length);
  return isEventTypeForSource(source, type) ? type : null;
}

/**
 * The account space of an account-grain source: the integration whose connect
 * flow restores delivery, the credential provider whose rows a trigger's
 * `accountRef` resolves against, and the connected rule a row must satisfy to
 * be one of those accounts (`credentialSatisfies(credential, row)`). Derived
 * from the entry and the integration registry, so the space is declared once.
 */
export interface EventDeliveryAccounts {
  integration: LiveProviderSlug;
  provider: CredentialProvider;
  credential: CredentialSpec;
}

export function eventDeliveryAccounts<S extends AccountGrainEventSource>(
  source: S,
): EventDeliveryAccounts;
export function eventDeliveryAccounts(source: EventSource): EventDeliveryAccounts | null;
/** The account space of `source`, or `null` for a source-grain source. */
export function eventDeliveryAccounts(source: EventSource): EventDeliveryAccounts | null {
  const delivery = EVENT_SOURCE_ENTRIES[source].delivery;
  if (delivery.grain === "source") return null;
  return {
    integration: delivery.integration,
    provider: credentialProviderOf(delivery.integration),
    credential: INTEGRATIONS[delivery.integration].credential,
  };
}
