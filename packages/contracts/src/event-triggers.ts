import { z } from "zod";
import { enumGuard } from "./guards";
import {
  INTEGRATIONS,
  credentialProviderOf,
  type CredentialProvider,
  type CredentialSpec,
  type LiveProviderSlug,
} from "./integrations";
import { humanizeSlug, integrationDisplayName } from "./tools";

/**
 * Where a source's delivery can break (#976): once per user (`source`), or per
 * connected account of `integration` (`account`, such as Gmail's push watch).
 */
export type EventDeliveryGrain =
  | { grain: "source" }
  | { grain: "account"; integration: LiveProviderSlug };

/**
 * How a user can subscribe a workflow to a source (ADR-0097). All authoring
 * lists and guards derive from this field.
 * - `typed`: name a declared event type.
 * - `raw`: name `type: "raw"` and a provider kind already seen. Typed kinds stay
 *   built-in only. Only an inbound source can be `raw`.
 * - `none`: built-in flows only.
 */
export type EventSourceAuthoring = "typed" | "raw" | "none";

interface EventSourceEntryBase {
  eventTypes: readonly [string, ...string[]];
  authoring: EventSourceAuthoring;
}

/**
 * `inbound_webhook` sources arrive on `POST /webhooks/inbound/:source` and each
 * needs an `InboundSourceDescriptor` (the compiler checks this). Their health is
 * per user, so they are `source` grain only.
 */
export type EventSourceEntry =
  | (EventSourceEntryBase & {
      producer: "in_process";
      delivery: EventDeliveryGrain;
      authoring: Exclude<EventSourceAuthoring, "raw">;
    })
  | (EventSourceEntryBase & { producer: "inbound_webhook"; delivery: { grain: "source" } });

/** Every event source (ADR-0047, ADR-0097). The keys are the source space. */
export const EVENT_SOURCE_ENTRIES = {
  gmail: {
    producer: "in_process",
    // One Pub/Sub watch per Google account, and each can lapse.
    delivery: { grain: "account", integration: "gmail" },
    authoring: "typed",
    eventTypes: ["message_received", "documents_ingested"],
  },
  "google.oauth.callback": {
    producer: "in_process",
    delivery: { grain: "source" },
    authoring: "none",
    eventTypes: ["completed"],
  },
  "learn-skill": {
    producer: "in_process",
    delivery: { grain: "source" },
    authoring: "none",
    eventTypes: ["completed"],
  },
  github: {
    producer: "inbound_webhook",
    delivery: { grain: "source" },
    authoring: "raw",
    // The GitHub App's subscribed `default_events`, plus `check_suite` (#1093).
    // `repository_dispatch` carries Vercel deployment events in `client_payload` (#1167).
    // A named kind leaves the raw tier; `authoring: "raw"` keeps it off the trigger list.
    eventTypes: [
      "pull_request",
      "push",
      "issues",
      "pull_request_review",
      "check_suite",
      "repository_dispatch",
    ],
  },
  /**
   * One type per `<resource>_<action>` (`Sentry-Hook-Resource` plus `action`).
   * `error_created` needs Sentry Business+; `event_alert_triggered` works on every
   * plan. `seer_pr_created` is the Seer Autofix PR (#563, #567).
   */
  sentry: {
    producer: "inbound_webhook",
    delivery: { grain: "source" },
    authoring: "raw",
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
   * `classify` publishes `classified` for the reply-drafting gate (ADR-0098).
   * Nothing publishes `reply_worthy`: the gate starts the run directly, and the
   * `reply-drafting` builtin declares it only to name its cause.
   */
  "email-triage": {
    producer: "in_process",
    delivery: { grain: "source" },
    authoring: "none",
    eventTypes: ["classified", "reply_worthy"],
  },
} as const satisfies Record<string, EventSourceEntry>;

export type EventSource = keyof typeof EVENT_SOURCE_ENTRIES;

export type EventSourceEntryOf<S extends EventSource> = (typeof EVENT_SOURCE_ENTRIES)[S];

/** In record order. */
export const EVENT_SOURCES: readonly EventSource[] =
  // SAFETY: the keys of a non-indexed literal are exactly `keyof typeof EVENT_SOURCE_ENTRIES`.
  Object.keys(EVENT_SOURCE_ENTRIES) as EventSource[];

export const isEventSource = enumGuard(EVENT_SOURCES);

/** The sources whose entry extends `P`. */
export type EventSourcesWhere<P> = {
  [S in EventSource]: EventSourceEntryOf<S> extends P ? S : never;
}[EventSource];

export type InboundEventSource = EventSourcesWhere<{ producer: "inbound_webhook" }>;

export type InProcessEventSource = EventSourcesWhere<{ producer: "in_process" }>;

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

export const EVENT_TYPES_BY_SOURCE: {
  readonly [S in EventSource]: EventSourceEntryOf<S>["eventTypes"];
} =
  // SAFETY: built from EVENT_SOURCES, so each key maps to its own `eventTypes` tuple.
  Object.fromEntries(
    EVENT_SOURCES.map((source) => [source, EVENT_SOURCE_ENTRIES[source].eventTypes]),
  ) as { [S in EventSource]: EventSourceEntryOf<S>["eventTypes"] };

export const EVENT_TYPES = Object.freeze([
  ...new Set(EVENT_SOURCES.flatMap((source) => EVENT_SOURCE_ENTRIES[source].eventTypes)),
]);

export const isEventType = enumGuard(EVENT_TYPES);

export function isEventTypeForSource<S extends EventSource>(
  source: S,
  value: string,
): value is EventTypeForSource<S> {
  // SAFETY: widening only types the `.includes` receiver.
  return (EVENT_SOURCE_ENTRIES[source].eventTypes as readonly string[]).includes(value);
}

/** The `<source>.<type>` name in `event_receipts.event_type`, trigger labels, and logs. */
export function eventTypeName<S extends EventSource>(
  source: S,
  type: EventTypeForSource<S>,
): `${S}.${EventTypeForSource<S>}` {
  return `${source}.${type}`;
}

/**
 * A delivery of an undeclared kind is stored as `<source>.raw`, with the provider
 * kind in `raw_kind` (ADR-0097). This is `never` if an entry declares a `raw` type,
 * which breaks `rawEventTypeName`: raw rows would then read as subscribed events.
 */
export type RawReceiptType = "raw" extends EventType ? never : "raw";

export const RAW_EVENT_TYPE: RawReceiptType = "raw";

export function isRawEventType(value: string): value is RawReceiptType {
  return value === RAW_EVENT_TYPE;
}

/** The provider's own kind, verbatim (`comment.created`). */
export const rawEventKindSchema = z.string().min(1).max(200);

export function rawEventTypeName<S extends InboundEventSource>(
  source: S,
): `${S}.${RawReceiptType}` {
  return `${source}.${RAW_EVENT_TYPE}`;
}

export type AuthorableEventSource = EventSourcesWhere<{ authoring: "typed" | "raw" }>;

export type TypedAuthorableEventSource = EventSourcesWhere<{ authoring: "typed" }>;

export type RawAuthorableEventSource = EventSourcesWhere<{ authoring: "raw" }>;

export function eventSourceAuthoring(source: EventSource): EventSourceAuthoring {
  return EVENT_SOURCE_ENTRIES[source].authoring;
}

export const AUTHORABLE_EVENT_SOURCES: readonly AuthorableEventSource[] = EVENT_SOURCES.filter(
  (source): source is AuthorableEventSource => eventSourceAuthoring(source) !== "none",
);

export const AUTHORABLE_TYPED_EVENT_SOURCES: readonly TypedAuthorableEventSource[] =
  EVENT_SOURCES.filter(
    (source): source is TypedAuthorableEventSource => eventSourceAuthoring(source) === "typed",
  );

export const AUTHORABLE_RAW_EVENT_SOURCES: readonly RawAuthorableEventSource[] =
  EVENT_SOURCES.filter(
    (source): source is RawAuthorableEventSource => eventSourceAuthoring(source) === "raw",
  );

export const isAuthorableEventSource = enumGuard(AUTHORABLE_EVENT_SOURCES);

export const isTypedAuthorableEventSource = enumGuard(AUTHORABLE_TYPED_EVENT_SOURCES);

export const isRawAuthorableEventSource = enumGuard(AUTHORABLE_RAW_EVENT_SOURCES);

export interface AuthorableEventTriggerIssue {
  path: "source" | "type" | "rawKind";
  message: string;
}

/** The raw-tier rule for stored and authored triggers alike. */
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
 * The rule for a user-authored trigger, shared by the editor and chat authoring.
 * The revision service checks separately that the source has seen the raw kind.
 */
export function authorableEventTriggerIssue(trigger: {
  source: AuthorableEventSource;
  type: string;
  rawKind?: string | undefined;
}): AuthorableEventTriggerIssue | null {
  const tierIssue = rawEventTriggerIssue(trigger);

  if (tierIssue) return tierIssue;

  if (isRawEventType(trigger.type)) {
    if (isRawAuthorableEventSource(trigger.source)) return null;

    return {
      path: "type",
      message: `'${trigger.source}' does not accept a raw event trigger; name one of its event types`,
    };
  }

  if (!isTypedAuthorableEventSource(trigger.source)) {
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

/** The caller names the source because sources contain dots (`google.oauth.callback`). */
export function parseEventTypeName<S extends EventSource>(
  source: S,
  name: string,
): EventTypeForSource<S> | null {
  const prefix = `${source}.`;

  if (!name.startsWith(prefix)) return null;
  const type = name.slice(prefix.length);

  return isEventTypeForSource(source, type) ? type : null;
}

/** `Sentry comment.created` for a raw trigger, `Gmail message` for a typed one. */
export function eventTriggerPhrase(trigger: {
  source: string;
  type?: string | null | undefined;
  rawKind?: string | null | undefined;
}): string {
  const source = integrationDisplayName(trigger.source);

  if (trigger.rawKind) return `${source} ${trigger.rawKind}`;

  const noun = trigger.type
    ? humanizeSlug(trigger.type.replace(/_received$/, "")).toLowerCase()
    : "";

  return noun ? `${source} ${noun}` : source;
}

/**
 * The accounts of an account-grain source: credential rows of `provider` that
 * pass `credentialSatisfies(credential, row)`. `integration` is what to reconnect.
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
/** `null` for a source-grain source. */
export function eventDeliveryAccounts(source: EventSource): EventDeliveryAccounts | null {
  const delivery = EVENT_SOURCE_ENTRIES[source].delivery;

  if (delivery.grain === "source") return null;

  return {
    integration: delivery.integration,
    provider: credentialProviderOf(delivery.integration),
    credential: INTEGRATIONS[delivery.integration].credential,
  };
}
