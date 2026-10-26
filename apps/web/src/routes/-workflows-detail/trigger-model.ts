import {
  EVENT_TYPES_BY_SOURCE,
  isAuthorableEventSource,
  isIanaTimezone,
  isRawAuthorableEventSource,
  isTypedAuthorableEventSource,
  RAW_EVENT_TYPE,
  type AuthorableEventSource,
  type RawAuthorableEventSource,
} from "@alfred/contracts";
import {
  isLikelyValidWorkflowCron,
  type SyncedWorkflow,
  type WorkflowUpdateArgs,
} from "@alfred/sync";

/**
 * Authorable trigger kinds. No `on_signal`: nothing produces signals yet (ADR-0047).
 * Each event source's options come from its `authoring` field in `@alfred/contracts`.
 */
export type TriggerKind = "cron" | "event" | "manual";

/** Every trigger field, also the ones the selected kind hides, so a kind switch keeps them. */
export interface TriggerDraft {
  kind: TriggerKind;
  cronSchedule: string;
  cronTimezone: string;
  eventSource: AuthorableEventSource;
  eventType: string;
  /** Empty until the user picks one. */
  eventRawKind: string;
}

export interface TriggerIssues {
  cronEmpty: boolean;
  cronInvalid: boolean;
  timezoneInvalid: boolean;
  rawKindMissing: boolean;
  /** True when any flag above is true. Save reads this, not the flags one by one. */
  blocksSave: boolean;
}

/** Empty for a raw-authorable source. */
export function typedEventTypes(source: AuthorableEventSource): readonly string[] {
  return isTypedAuthorableEventSource(source) ? EVENT_TYPES_BY_SOURCE[source] : [];
}

/** The raw-authorable source when the draft is a raw event trigger; otherwise null. */
export function rawEventSource(trigger: TriggerDraft): RawAuthorableEventSource | null {
  return trigger.kind === "event" && isRawAuthorableEventSource(trigger.eventSource)
    ? trigger.eventSource
    : null;
}

export function triggerDraftFromWorkflow(t: SyncedWorkflow["trigger"]): TriggerDraft {
  const eventSource: AuthorableEventSource =
    t.kind === "event" && isAuthorableEventSource(t.source) ? t.source : "gmail";

  return {
    kind: t.kind === "cron" || t.kind === "event" || t.kind === "manual" ? t.kind : "manual",
    cronSchedule: t.kind === "cron" ? t.schedule : "0 8 * * *",
    cronTimezone: t.kind === "cron" ? (t.timezone ?? "") : "",
    eventSource,
    eventType: t.kind === "event" ? t.type : (typedEventTypes(eventSource)[0] ?? ""),
    eventRawKind: t.kind === "event" ? (t.rawKind ?? "") : "",
  };
}

export function buildTrigger(trigger: TriggerDraft): WorkflowUpdateArgs["trigger"] {
  if (trigger.kind === "cron") {
    const timezone = trigger.cronTimezone.trim();

    return {
      kind: "cron",
      schedule: trigger.cronSchedule.trim(),
      // `triggerIssues` blocks save on a bad zone, so this guard only narrows the type.
      ...(isIanaTimezone(timezone) ? { timezone } : {}),
    };
  }

  if (trigger.kind === "event") {
    if (isRawAuthorableEventSource(trigger.eventSource)) {
      return {
        kind: "event",
        source: trigger.eventSource,
        type: RAW_EVENT_TYPE,
        rawKind: trigger.eventRawKind,
      };
    }

    return { kind: "event", source: trigger.eventSource, type: trigger.eventType };
  }

  return { kind: "manual" };
}

export function triggerIssues(trigger: TriggerDraft): TriggerIssues {
  const cronEmpty = trigger.kind === "cron" && trigger.cronSchedule.trim() === "";
  const timezone = trigger.cronTimezone.trim();

  const flags = {
    cronEmpty,
    cronInvalid:
      trigger.kind === "cron" && !cronEmpty && !isLikelyValidWorkflowCron(trigger.cronSchedule),
    timezoneInvalid: trigger.kind === "cron" && timezone !== "" && !isIanaTimezone(timezone),
    rawKindMissing: rawEventSource(trigger) !== null && trigger.eventRawKind === "",
  } satisfies Omit<TriggerIssues, "blocksSave">;

  // A new flag must join `flags` to compile, and then it blocks save with no other edit.
  return { ...flags, blocksSave: Object.values(flags).some(Boolean) };
}

/** Compares the hidden fields too, so an edit under another kind still counts as a change. */
export function sameTriggerDraft(a: TriggerDraft, b: TriggerDraft): boolean {
  return (
    a.kind === b.kind &&
    a.cronSchedule === b.cronSchedule &&
    a.cronTimezone === b.cronTimezone &&
    a.eventSource === b.eventSource &&
    a.eventType === b.eventType &&
    a.eventRawKind === b.eventRawKind
  );
}
