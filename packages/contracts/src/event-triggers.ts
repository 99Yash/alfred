import { enumGuard } from "./guards";

export const EVENT_SOURCES = ["gmail", "google.oauth.callback", "learn-skill"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const GMAIL_EVENT_TYPES = ["message_received", "documents_ingested"] as const;
export const GOOGLE_OAUTH_CALLBACK_EVENT_TYPES = ["completed"] as const;
export const LEARN_SKILL_EVENT_TYPES = ["completed"] as const;

export const EVENT_TYPES_BY_SOURCE = {
  gmail: GMAIL_EVENT_TYPES,
  "google.oauth.callback": GOOGLE_OAUTH_CALLBACK_EVENT_TYPES,
  "learn-skill": LEARN_SKILL_EVENT_TYPES,
} as const satisfies Record<EventSource, readonly string[]>;

export type EventTypeForSource<S extends EventSource> = (typeof EVENT_TYPES_BY_SOURCE)[S][number];

export type EventType = {
  [S in EventSource]: EventTypeForSource<S>;
}[EventSource];

export const EVENT_TYPES =
  // SAFETY: every element comes from EVENT_TYPES_BY_SOURCE's per-source const
  // tuples, whose members are exactly the EventType literals; Set only
  // dedupes, so the frozen array is a readonly EventType[].
  Object.freeze([
    // De-duplicate: multiple sources share an event type (e.g. both
    // `google.oauth.callback` and `learn-skill` emit `completed`), so a raw
    // `.flat()` would repeat it. Keep this a canonical set of unique types.
    // SAFETY: every element comes from EVENT_TYPES_BY_SOURCE's per-source const
    // tuples, whose members are exactly the EventType literals; Set only
    // dedupes, so the frozen array is a readonly EventType[].
    ...new Set(Object.values(EVENT_TYPES_BY_SOURCE).flat()),
  ]) as readonly EventType[];

export const isEventSource = enumGuard(EVENT_SOURCES);

export const isEventType = enumGuard(EVENT_TYPES);

export function isEventTypeForSource<S extends EventSource>(
  source: S,
  value: string,
): value is EventTypeForSource<S> {
  // SAFETY: the per-source row is a const tuple of that source's event-type
  // literals; widening to readonly string[] only types the .includes receiver
  // for the runtime membership test this guard performs.
  return (EVENT_TYPES_BY_SOURCE[source] as readonly string[]).includes(value);
}
