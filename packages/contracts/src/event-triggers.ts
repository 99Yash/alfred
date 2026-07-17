export const EVENT_SOURCES = ["gmail", "google.oauth.callback", "learn-skill"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const GMAIL_EVENT_TYPES = ["message_received"] as const;
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

export const EVENT_TYPES = Object.freeze([
  // De-duplicate: multiple sources share an event type (e.g. both
  // `google.oauth.callback` and `learn-skill` emit `completed`), so a raw
  // `.flat()` would repeat it. Keep this a canonical set of unique types.
  ...new Set(Object.values(EVENT_TYPES_BY_SOURCE).flat()),
]) as readonly EventType[];

export function isEventSource(value: string): value is EventSource {
  return (EVENT_SOURCES as readonly string[]).includes(value);
}

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export function isEventTypeForSource<S extends EventSource>(
  source: S,
  value: string,
): value is EventTypeForSource<S> {
  return (EVENT_TYPES_BY_SOURCE[source] as readonly string[]).includes(value);
}
