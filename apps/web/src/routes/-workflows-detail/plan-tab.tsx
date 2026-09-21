import {
  AUTHORABLE_EVENT_SOURCES,
  EVENT_TYPES_BY_SOURCE,
  integrationDisplayName,
  isAuthorableEventSource,
  isIanaTimezone,
  isRawAuthorableEventSource,
  isTypedAuthorableEventSource,
  LOADABLE_INTEGRATION_SLUGS,
  RAW_EVENT_TYPE,
  type AuthorableEventSource,
  type LoadableIntegrationSlug,
} from "@alfred/contracts";
import {
  isLikelyValidWorkflowCron,
  type SyncedWorkflow,
  type WorkflowUpdateArgs,
} from "@alfred/sync";
import { AlertTriangle, Link2, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { AppButton, AppCard, AppPill, AppSegmented, AppTextarea } from "~/components/ui/v2";
import { AppInput } from "~/components/ui/v2/input";
import { AppSelect } from "~/components/ui/v2/select";
import { useRawReceiptKinds } from "~/lib/integrations/use-raw-kinds";
import { cn } from "~/lib/utils";
import { WorkflowIcon } from "./workflow-icon";

/**
 * Trigger kinds a user can author. `on_signal` is intentionally absent —
 * no signal producer exists yet (ADR-0047 8b deferred), so the editor
 * never offers it. Event sources and what each offers derive from the entry's
 * `authoring` field in `@alfred/contracts` (#990): a `typed` source (Gmail)
 * offers its declared events; a `raw` source (GitHub, Sentry) offers the raw
 * kinds its inventory has seen, and the saved trigger is
 * `{ type: "raw", rawKind }`. The editor holds no policy of its own.
 */
type TriggerKind = "cron" | "event" | "manual";

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

/** The typed events the editor offers for a source; empty for a raw-authorable source. */
function typedEventTypes(source: AuthorableEventSource): readonly string[] {
  return isTypedAuthorableEventSource(source) ? EVENT_TYPES_BY_SOURCE[source] : [];
}

interface Draft {
  name: string;
  brief: string;
  kind: TriggerKind;
  cronSchedule: string;
  cronTimezone: string;
  eventSource: AuthorableEventSource;
  eventType: string;
  /** The provider kind for an inbound source; empty until the user picks one. */
  eventRawKind: string;
  allowed: LoadableIntegrationSlug[];
}

function draftFromWorkflow(w: SyncedWorkflow): Draft {
  const t = w.trigger;

  const eventSource: AuthorableEventSource =
    t.kind === "event" && isAuthorableEventSource(t.source) ? t.source : "gmail";

  return {
    name: w.name,
    brief: w.brief ?? "",
    kind: t.kind === "cron" || t.kind === "event" || t.kind === "manual" ? t.kind : "manual",
    cronSchedule: t.kind === "cron" ? t.schedule : "0 8 * * *",
    cronTimezone: t.kind === "cron" ? (t.timezone ?? "") : "",
    eventSource,
    eventType: t.kind === "event" ? t.type : (typedEventTypes(eventSource)[0] ?? ""),
    eventRawKind: t.kind === "event" ? (t.rawKind ?? "") : "",
    allowed: w.allowedIntegrations.filter((s): s is LoadableIntegrationSlug =>
      // SAFETY: widening the const tuple only types the .includes receiver for
      // this membership test.
      (LOADABLE_INTEGRATION_SLUGS as readonly string[]).includes(s),
    ),
  };
}

function buildTrigger(draft: Draft): WorkflowUpdateArgs["trigger"] {
  if (draft.kind === "cron") {
    const timezone = draft.cronTimezone.trim();

    return {
      kind: "cron",
      schedule: draft.cronSchedule.trim(),
      ...(timezone ? { timezone } : {}),
    };
  }

  if (draft.kind === "event") {
    if (isRawAuthorableEventSource(draft.eventSource)) {
      return {
        kind: "event",
        source: draft.eventSource,
        type: RAW_EVENT_TYPE,
        rawKind: draft.eventRawKind,
      };
    }

    return { kind: "event", source: draft.eventSource, type: draft.eventType };
  }

  return { kind: "manual" };
}

function sameAllowed(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);

  return b.every((s) => set.has(s));
}

export function PlanTab({
  workflow,
  onSave,
}: {
  workflow: SyncedWorkflow;
  onSave: (args: Omit<WorkflowUpdateArgs, "slug" | "expectedRowVersion">) => Promise<void>;
}) {
  const readOnly = workflow.isBuiltin;
  // The draft seeds once per mount. The parent keys this component on
  // `slug:rowVersion`, so when the row changes underneath us (our own save bumps
  // rowVersion, or another device edits it) React remounts and re-seeds — no sync
  // effect, no stale-workflow capture. Mid-edit clobbering is acceptable at
  // single-user scale and keeps the form honest to the synced row.
  const [draft, setDraft] = useState<Draft>(() => draftFromWorkflow(workflow));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const eventTypes = typedEventTypes(draft.eventSource);

  // The raw inventory is the option list for a raw-authorable source. The hook
  // call stays unconditional; `null` disables the query for Gmail and non-event kinds.
  const rawSource =
    draft.kind === "event" && isRawAuthorableEventSource(draft.eventSource)
      ? draft.eventSource
      : null;

  const rawKinds = useRawReceiptKinds(rawSource);

  const rawKindOptions = useMemo(
    () => (rawKinds.data?.kinds ?? []).map((entry) => ({ value: entry.kind, label: entry.kind })),
    [rawKinds.data],
  );

  const rawInventoryEmpty = rawSource !== null && rawKinds.isSuccess && rawKindOptions.length === 0;
  const rawKindMissing = rawSource !== null && draft.eventRawKind === "";

  // The event trigger source must be inside a non-empty allowed-integration
  // cap, or the run can't act on what fired it (server rejects this too).
  const eventCapViolation =
    draft.kind === "event" &&
    draft.allowed.length > 0 &&
    !draft.allowed.includes(draft.eventSource);

  const cronEmpty = draft.kind === "cron" && draft.cronSchedule.trim() === "";

  const cronInvalid =
    draft.kind === "cron" && !cronEmpty && !isLikelyValidWorkflowCron(draft.cronSchedule);

  const timezoneInvalid =
    draft.kind === "cron" &&
    draft.cronTimezone.trim() !== "" &&
    !isIanaTimezone(draft.cronTimezone.trim());

  const nameEmpty = draft.name.trim() === "";

  const invalid =
    nameEmpty || cronEmpty || cronInvalid || timezoneInvalid || eventCapViolation || rawKindMissing;

  const dirty = useMemo(() => {
    const original = draftFromWorkflow(workflow);

    return (
      draft.name !== original.name ||
      draft.brief !== original.brief ||
      draft.kind !== original.kind ||
      draft.cronSchedule !== original.cronSchedule ||
      draft.cronTimezone !== original.cronTimezone ||
      draft.eventSource !== original.eventSource ||
      draft.eventType !== original.eventType ||
      draft.eventRawKind !== original.eventRawKind ||
      !sameAllowed(draft.allowed, original.allowed)
    );
  }, [draft, workflow]);

  const toggleAllowed = (slug: LoadableIntegrationSlug) => {
    setDraft((d) => ({
      ...d,
      allowed: d.allowed.includes(slug)
        ? d.allowed.filter((s) => s !== slug)
        : [...d.allowed, slug],
    }));
  };

  const handleSave = async () => {
    if (readOnly || invalid || !dirty || saving) return;
    setSaving(true);
    setSaveError(null);

    try {
      await onSave({
        name: draft.name.trim(),
        brief: draft.brief.trim() === "" ? null : draft.brief.trim(),
        allowedIntegrations: draft.allowed,
        trigger: buildTrigger(draft),
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4">
      {readOnly ? (
        <div className="flex items-center gap-2 rounded-xl bg-app-bg-2 px-3 py-2 text-xs text-app-fg-3">
          <Lock size={13} />
          Built-in workflow. Its definition is managed by Alfred and can't be edited here.
        </div>
      ) : null}

      <AppCard>
        <label className="text-sm font-medium text-app-fg-4" htmlFor="app-workflow-name">
          Name
        </label>
        <AppInput
          id="app-workflow-name"
          value={draft.name}
          readOnly={readOnly}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className="mt-3"
          aria-label="Workflow name"
        />
        {nameEmpty && !readOnly ? (
          <p className="mt-2 text-xs text-app-red-4">Name is required.</p>
        ) : null}
      </AppCard>

      <AppCard>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-app-fg-4">When</span>
          <AppSegmented<TriggerKind>
            value={draft.kind}
            onValueChange={(kind) => !readOnly && setDraft((d) => ({ ...d, kind }))}
            items={TRIGGER_TABS}
            label="When this workflow runs"
          />
        </div>

        {draft.kind === "cron" ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-app-fg-4">
              <span className="text-app-fg-3">Cron</span>
              <AppInput
                value={draft.cronSchedule}
                readOnly={readOnly}
                onChange={(e) => setDraft((d) => ({ ...d, cronSchedule: e.target.value }))}
                className="w-44 font-mono"
                placeholder="0 8 * * *"
                aria-label="Cron expression"
              />
              <span className="text-app-fg-3">timezone</span>
              <AppInput
                value={draft.cronTimezone}
                readOnly={readOnly}
                onChange={(e) => setDraft((d) => ({ ...d, cronTimezone: e.target.value }))}
                className="w-48"
                placeholder="UTC (or America/New_York)"
                aria-label="Cron timezone"
              />
            </div>
            <p className="text-xs text-app-fg-3">
              Standard 5-field cron. Leave timezone blank to inherit your account timezone.
            </p>
            {cronInvalid ? (
              <p className="text-xs text-app-red-4">Use a valid 5-field cron expression.</p>
            ) : null}
            {timezoneInvalid ? (
              <p className="text-xs text-app-red-4">
                Use a valid IANA timezone, or leave it blank.
              </p>
            ) : null}
          </div>
        ) : null}

        {draft.kind === "event" ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-app-fg-4">
              <span className="text-app-fg-3">On</span>
              <AppSegmented<AuthorableEventSource>
                value={draft.eventSource}
                onValueChange={(eventSource) =>
                  !readOnly &&
                  setDraft((d) => ({
                    ...d,
                    eventSource,
                    eventType: typedEventTypes(eventSource)[0] ?? "",
                    eventRawKind: "",
                  }))
                }
                items={AUTHORABLE_EVENT_SOURCE_OPTIONS}
                label="Event source"
              />
              <span className="text-app-fg-3">when</span>
              {rawSource === null ? (
                <AppSegmented<string>
                  value={draft.eventType}
                  onValueChange={(eventType) => !readOnly && setDraft((d) => ({ ...d, eventType }))}
                  items={eventTypes.map((t) => ({
                    value: t,
                    label: eventTypeLabel(t),
                  }))}
                  label="Event type"
                />
              ) : (
                <AppSelect
                  value={draft.eventRawKind === "" ? undefined : draft.eventRawKind}
                  onChange={(eventRawKind) =>
                    !readOnly && setDraft((d) => ({ ...d, eventRawKind: eventRawKind ?? "" }))
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
              Alfred runs this workflow each time the selected event arrives, with the triggering
              item passed in as context.
            </p>
            {rawInventoryEmpty ? (
              <p className="text-xs text-app-amber-4">
                {integrationDisplayName(draft.eventSource)} has not delivered any events yet. Kinds
                appear here the day the first one arrives; see the integration page under Unmapped
                events.
              </p>
            ) : null}
            {rawSource !== null && rawKinds.isError ? (
              <p className="text-xs text-app-red-4">
                Could not load the event kinds for {integrationDisplayName(draft.eventSource)}.
              </p>
            ) : null}
          </div>
        ) : null}

        {draft.kind === "manual" ? (
          <p className="mt-4 text-xs leading-5 text-app-fg-3">
            This workflow only runs when you trigger it with <strong>Run now</strong>. No schedule
            or event.
          </p>
        ) : null}
      </AppCard>

      <AppCard>
        <label className="text-sm font-medium text-app-fg-4" htmlFor="app-workflow-prompt">
          Prompt
        </label>
        <AppTextarea
          id="app-workflow-prompt"
          value={draft.brief}
          readOnly={readOnly}
          onChange={(e) => setDraft((d) => ({ ...d, brief: e.target.value }))}
          className="mt-3 min-h-[152px]"
          placeholder="Describe what Alfred should do. Mention integrations with @gmail, @calendar, …"
          aria-label={`${workflow.name} prompt`}
        />
      </AppCard>

      <AppCard>
        <div className="flex items-start gap-3">
          <WorkflowIcon tone="purple">
            <Link2 size={16} />
          </WorkflowIcon>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-app-fg-4">Allowed integrations</p>
            <p className="mt-1 text-xs leading-5 text-app-fg-3">
              The cap on which integrations this workflow may load. Empty means unrestricted (any
              connected integration).
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {LOADABLE_INTEGRATION_SLUGS.map((slug) => {
                const selected = draft.allowed.includes(slug);

                return (
                  <AppPill
                    key={slug}
                    type="button"
                    variant={selected ? "accent" : "default"}
                    tone={selected ? "purple" : undefined}
                    disabled={readOnly}
                    onClick={() => toggleAllowed(slug)}
                    className={cn(!selected && "opacity-70")}
                  >
                    {integrationDisplayName(slug)}
                  </AppPill>
                );
              })}
            </div>
          </div>
        </div>
      </AppCard>

      {eventCapViolation ? (
        <div className="flex items-center gap-2 rounded-xl bg-app-amber-1 px-3 py-2 text-xs text-app-amber-4">
          <AlertTriangle size={13} />
          Add <strong>{integrationDisplayName(draft.eventSource)}</strong> to the allowed
          integrations, or clear the cap. An event workflow must be allowed to use its own trigger
          source.
        </div>
      ) : null}

      {saveError ? (
        <div className="flex items-center gap-2 rounded-xl bg-app-red-1 px-3 py-2 text-xs text-app-red-4">
          <AlertTriangle size={13} />
          {saveError}
        </div>
      ) : null}

      {!readOnly ? (
        <div className="flex justify-end">
          <AppButton
            variant="primary"
            onClick={handleSave}
            disabled={invalid || !dirty || saving}
            title={
              invalid
                ? "Fix the highlighted fields first"
                : !dirty
                  ? "No changes to save"
                  : undefined
            }
          >
            {saving ? "Saving…" : "Submit changes"}
          </AppButton>
        </div>
      ) : null}
    </div>
  );
}
