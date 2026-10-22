import {
  AUTHORABLE_EVENT_SOURCES,
  integrationDisplayName,
  type AuthorableEventSource,
} from "@alfred/contracts";
import { useMemo } from "react";
import { AppCard, AppSegmented } from "~/components/ui/v2";
import { AppInput } from "~/components/ui/v2/input";
import { AppSelect } from "~/components/ui/v2/select";
import { useRawReceiptKinds } from "~/lib/integrations/use-raw-kinds";
import {
  rawEventSource,
  typedEventTypes,
  type TriggerDraft,
  type TriggerIssues,
  type TriggerKind,
} from "./trigger-model";

const TRIGGER_TABS: ReadonlyArray<{ value: TriggerKind; label: string }> = [
  { value: "cron", label: "Schedule" },
  { value: "event", label: "Event" },
  { value: "manual", label: "Manual" },
];

const AUTHORABLE_EVENT_SOURCE_OPTIONS: ReadonlyArray<{
  value: AuthorableEventSource;
  label: string;
}> = AUTHORABLE_EVENT_SOURCES.map((source) => ({
  value: source,
  label: integrationDisplayName(source),
}));

function eventTypeLabel(type: string): string {
  return type.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function EventTriggerFields({
  value,
  readOnly,
  onChange,
}: {
  value: TriggerDraft;
  readOnly: boolean;
  onChange: (next: TriggerDraft) => void;
}) {
  const eventTypes = typedEventTypes(value.eventSource);

  // Unconditional hook; `null` disables the query for a typed source such as Gmail.
  const rawSource = rawEventSource(value);
  const rawKinds = useRawReceiptKinds(rawSource);

  const rawKindOptions = useMemo(
    () => (rawKinds.data?.kinds ?? []).map((entry) => ({ value: entry.kind, label: entry.kind })),
    [rawKinds.data],
  );

  const rawInventoryEmpty = rawSource !== null && rawKinds.isSuccess && rawKindOptions.length === 0;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-app-fg-4">
        <span className="text-app-fg-3">On</span>
        <AppSegmented<AuthorableEventSource>
          value={value.eventSource}
          onValueChange={(eventSource) =>
            !readOnly &&
            onChange({
              ...value,
              eventSource,
              eventType: typedEventTypes(eventSource)[0] ?? "",
              eventRawKind: "",
            })
          }
          items={AUTHORABLE_EVENT_SOURCE_OPTIONS}
          label="Event source"
        />
        <span className="text-app-fg-3">when</span>
        {rawSource === null ? (
          <AppSegmented<string>
            value={value.eventType}
            onValueChange={(eventType) => !readOnly && onChange({ ...value, eventType })}
            items={eventTypes.map((t) => ({
              value: t,
              label: eventTypeLabel(t),
            }))}
            label="Event type"
          />
        ) : (
          <AppSelect
            value={value.eventRawKind === "" ? undefined : value.eventRawKind}
            onChange={(eventRawKind) =>
              !readOnly && onChange({ ...value, eventRawKind: eventRawKind ?? "" })
            }
            options={rawKindOptions}
            placeholder={rawKinds.isPending ? "Loading events…" : "Pick an event kind"}
            disabled={readOnly || rawKinds.isPending || rawKindOptions.length === 0}
            className="min-w-56 font-mono"
            label="Event kind"
          />
        )}
      </div>
      <p className="text-xs text-app-fg-3">
        Alfred runs this workflow each time the selected event arrives, with the triggering item
        passed in as context.
      </p>
      {rawInventoryEmpty ? (
        <p className="text-xs text-app-amber-4">
          {integrationDisplayName(value.eventSource)} has not delivered any events yet. Kinds appear
          here the day the first one arrives; see the integration page under Unmapped events.
        </p>
      ) : null}
      {rawSource !== null && rawKinds.isError ? (
        <p className="text-xs text-app-red-4">
          Could not load the event kinds for {integrationDisplayName(value.eventSource)}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The When card. It shows trigger validity but does not decide it: the plan tab
 * computes `issues` from the same draft it saves.
 */
export function TriggerEditor({
  value,
  issues,
  readOnly,
  onChange,
}: {
  value: TriggerDraft;
  issues: Pick<TriggerIssues, "cronInvalid" | "timezoneInvalid">;
  readOnly: boolean;
  onChange: (next: TriggerDraft) => void;
}) {
  return (
    <AppCard>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-app-fg-4">When</span>
        <AppSegmented<TriggerKind>
          value={value.kind}
          onValueChange={(kind) => !readOnly && onChange({ ...value, kind })}
          items={TRIGGER_TABS}
          label="When this workflow runs"
        />
      </div>

      {value.kind === "cron" ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-app-fg-4">
            <span className="text-app-fg-3">Cron</span>
            <AppInput
              value={value.cronSchedule}
              readOnly={readOnly}
              onChange={(e) => onChange({ ...value, cronSchedule: e.target.value })}
              className="w-44 font-mono"
              placeholder="0 8 * * *"
              aria-label="Cron expression"
            />
            <span className="text-app-fg-3">timezone</span>
            <AppInput
              value={value.cronTimezone}
              readOnly={readOnly}
              onChange={(e) => onChange({ ...value, cronTimezone: e.target.value })}
              className="w-48"
              placeholder="UTC (or America/New_York)"
              aria-label="Cron timezone"
            />
          </div>
          <p className="text-xs text-app-fg-3">
            Standard 5-field cron. Leave timezone blank to inherit your account timezone.
          </p>
          {issues.cronInvalid ? (
            <p className="text-xs text-app-red-4">Use a valid 5-field cron expression.</p>
          ) : null}
          {issues.timezoneInvalid ? (
            <p className="text-xs text-app-red-4">Use a valid IANA timezone, or leave it blank.</p>
          ) : null}
        </div>
      ) : null}

      {value.kind === "event" ? (
        <EventTriggerFields value={value} readOnly={readOnly} onChange={onChange} />
      ) : null}

      {value.kind === "manual" ? (
        <p className="mt-4 text-xs leading-5 text-app-fg-3">
          This workflow only runs when you trigger it with <strong>Run now</strong>. No schedule or
          event.
        </p>
      ) : null}
    </AppCard>
  );
}
