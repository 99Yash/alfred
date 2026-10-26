import {
  type IntegrationSlug,
  integrationDisplayName,
  LOADABLE_INTEGRATION_SLUGS,
  type LoadableIntegrationSlug,
} from "@alfred/contracts";
import { type SyncedWorkflow, type WorkflowUpdateArgs } from "@alfred/sync";
import { AlertTriangle, Link2, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { AppButton, AppCard, AppPill, AppTextarea } from "~/components/ui/v2";
import { AppInput } from "~/components/ui/v2/input";
import { cn } from "~/lib/utils";
import { TriggerEditor } from "./trigger-editor";
import {
  buildTrigger,
  sameTriggerDraft,
  triggerDraftFromWorkflow,
  triggerIssues,
  type TriggerDraft,
} from "./trigger-model";
import { WorkflowIcon } from "./workflow-icon";

interface Draft {
  name: string;
  brief: string;
  trigger: TriggerDraft;
  /** The full stored cap. Internal slugs (`system`, `mcp`) stay, and only loadable slugs get a checkbox. */
  allowed: IntegrationSlug[];
}

function draftFromWorkflow(w: SyncedWorkflow): Draft {
  return {
    name: w.name,
    brief: w.brief ?? "",
    trigger: triggerDraftFromWorkflow(w.trigger),
    allowed: [...w.allowedIntegrations],
  };
}

function sameAllowed(
  a: ReadonlyArray<IntegrationSlug>,
  b: ReadonlyArray<IntegrationSlug>,
): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);

  return b.every((s) => set.has(s));
}

/** The submit action and the reason it is disabled. */
function SaveButton({
  invalid,
  dirty,
  saving,
  onSave,
}: {
  invalid: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="flex justify-end">
      <AppButton
        variant="primary"
        onClick={onSave}
        disabled={invalid || !dirty || saving}
        title={
          invalid ? "Fix the highlighted fields first" : !dirty ? "No changes to save" : undefined
        }
      >
        {saving ? "Saving…" : "Submit changes"}
      </AppButton>
    </div>
  );
}

export function PlanTab({
  workflow,
  onSave,
}: {
  workflow: SyncedWorkflow;
  onSave: (args: Omit<WorkflowUpdateArgs, "slug" | "expectedRowVersion">) => Promise<void>;
}) {
  const readOnly = workflow.isBuiltin;
  // Seeds once. The parent keys this on `slug:rowVersion`, so a changed row remounts it.
  const [draft, setDraft] = useState<Draft>(() => draftFromWorkflow(workflow));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The one trigger validity call; the editor only shows it.
  const issues = triggerIssues(draft.trigger);

  // The source must be inside a non-empty integration cap, or the run cannot act (the server checks too).
  const eventCapViolation =
    draft.trigger.kind === "event" &&
    draft.allowed.length > 0 &&
    !draft.allowed.includes(draft.trigger.eventSource);

  const nameEmpty = draft.name.trim() === "";

  const invalid = nameEmpty || eventCapViolation || issues.blocksSave;

  const dirty = useMemo(() => {
    const original = draftFromWorkflow(workflow);

    return (
      draft.name !== original.name ||
      draft.brief !== original.brief ||
      !sameTriggerDraft(draft.trigger, original.trigger) ||
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
        trigger: buildTrigger(draft.trigger),
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
        <div className="flex items-center gap-2 rounded-surface bg-app-bg-2 px-3 py-2 text-xs text-app-fg-3">
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

      <TriggerEditor
        value={draft.trigger}
        issues={issues}
        readOnly={readOnly}
        onChange={(next) => setDraft((d) => ({ ...d, trigger: next }))}
      />

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
        <div className="flex items-center gap-2 rounded-surface bg-app-amber-1 px-3 py-2 text-xs text-app-amber-4">
          <AlertTriangle size={13} />
          Add <strong>{integrationDisplayName(draft.trigger.eventSource)}</strong> to the allowed
          integrations, or clear the cap. An event workflow must be allowed to use its own trigger
          source.
        </div>
      ) : null}

      {saveError ? (
        <div className="flex items-center gap-2 rounded-surface bg-app-red-1 px-3 py-2 text-xs text-app-red-4">
          <AlertTriangle size={13} />
          {saveError}
        </div>
      ) : null}

      {!readOnly ? (
        <SaveButton
          invalid={invalid}
          dirty={dirty}
          saving={saving}
          onSave={() => void handleSave()}
        />
      ) : null}
    </div>
  );
}
