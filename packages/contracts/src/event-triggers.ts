import { enumGuard } from "./guards";

/**
 * The browser-safe half of one event source: how its domain events are
 * produced and which event types a workflow may subscribe to.
 *
 * - `in_process`: the source's domain events are published by code inside the
 *   server (an ingestion worker, an OAuth callback, a workflow's terminal step).
 * - `inbound_webhook`: the source's domain events arrive as HTTP deliveries on
 *   `POST /webhooks/inbound/:source`. Every such source has an
 *   `InboundSourceDescriptor` in `@alfred/assistant/connections/ingress`, and the
 *   descriptor registry is typed `Record<InboundEventSource, …>`, so adding a
 *   source here without a descriptor there fails to compile (and vice versa).
 */
export interface EventSourceEntry {
  producer: "in_process" | "inbound_webhook";
  eventTypes: readonly [string, ...string[]];
}

/**
 * Every domain-event source, keyed by slug (ADR-0047, ADR-0097). The record's
 * keys are the source space: `EventSource` is `keyof` this object, and every
 * per-source table elsewhere is a projection of it or keyed
 * `satisfies Record<EventSource, …>` on a union it derives.
 */
export const EVENT_SOURCE_ENTRIES = {
  gmail: {
    producer: "in_process",
    eventTypes: ["message_received", "documents_ingested"],
  },
  "google.oauth.callback": {
    producer: "in_process",
    eventTypes: ["completed"],
  },
  "learn-skill": {
    producer: "in_process",
    eventTypes: ["completed"],
  },
  github: {
    producer: "inbound_webhook",
    // Mirrors the GitHub App's subscribed `default_events`.
    eventTypes: ["pull_request", "push", "issues", "pull_request_review"],
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
