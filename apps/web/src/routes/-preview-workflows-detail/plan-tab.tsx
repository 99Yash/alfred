import {
	EVENT_TYPES_BY_SOURCE,
	LOADABLE_INTEGRATION_SLUGS,
	type LoadableIntegrationSlug,
} from "@alfred/contracts";
import {
	AUTHORABLE_EVENT_SOURCES as AUTHORABLE_EVENT_SOURCE_VALUES,
	isLikelyValidWorkflowCron,
	type SyncedWorkflow,
	type WorkflowUpdateArgs,
} from "@alfred/sync";
import { AlertTriangle, Link2, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	VsButton,
	VsCard,
	VsPill,
	VsSegmented,
	VsTextarea,
} from "~/components/ui/visitors";
import { VsInput } from "~/components/ui/visitors/input";
import { cn } from "~/lib/utils";
import { WorkflowIcon } from "./workflow-icon";

/**
 * Trigger kinds a user can author. `on_signal` is intentionally absent —
 * no signal producer exists yet (ADR-0047 8b deferred), so the editor
 * never offers it. Event sources are limited to user-facing ones; the
 * internal sources (`google.oauth.callback`, `learn-skill`) drive built-in
 * flows and aren't authorable.
 */
type TriggerKind = "cron" | "event" | "manual";

const TRIGGER_TABS: ReadonlyArray<{ value: TriggerKind; label: string }> = [
	{ value: "cron", label: "Schedule" },
	{ value: "event", label: "Event" },
	{ value: "manual", label: "Manual" },
];

type AuthorableEventSource = (typeof AUTHORABLE_EVENT_SOURCE_VALUES)[number];

const AUTHORABLE_EVENT_SOURCE_OPTIONS: ReadonlyArray<{
	value: AuthorableEventSource;
	label: string;
}> = [{ value: "gmail", label: "Gmail" }];

function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

function isAuthorableEventSource(value: string): value is AuthorableEventSource {
	return (AUTHORABLE_EVENT_SOURCE_VALUES as readonly string[]).includes(value);
}

function eventTypeLabel(type: string): string {
	return type.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function integrationLabel(slug: string): string {
	return slug.replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Draft {
	name: string;
	brief: string;
	kind: TriggerKind;
	cronSchedule: string;
	cronTimezone: string;
	eventSource: AuthorableEventSource;
	eventType: string;
	allowed: LoadableIntegrationSlug[];
}

function draftFromWorkflow(w: SyncedWorkflow): Draft {
	const t = w.trigger;
	const eventSource: AuthorableEventSource =
		t.kind === "event" && isAuthorableEventSource(t.source) ? t.source : "gmail";
	return {
		name: w.name,
		brief: w.brief ?? "",
		kind:
			t.kind === "cron" || t.kind === "event" || t.kind === "manual"
				? t.kind
				: "manual",
		cronSchedule: t.kind === "cron" ? t.schedule : "0 8 * * *",
		cronTimezone: t.kind === "cron" ? (t.timezone ?? "") : "",
		eventSource,
		eventType:
			t.kind === "event"
				? t.type
				: (EVENT_TYPES_BY_SOURCE[eventSource][0] ?? ""),
		allowed: w.allowedIntegrations.filter((s): s is LoadableIntegrationSlug =>
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
		return { kind: "event", source: draft.eventSource, type: draft.eventType };
	}
	return { kind: "manual" };
}

function sameAllowed(
	a: ReadonlyArray<string>,
	b: ReadonlyArray<string>,
): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((s) => set.has(s));
}

export function PlanTab({
	workflow,
	onSave,
}: {
	workflow: SyncedWorkflow;
	onSave: (args: Omit<WorkflowUpdateArgs, "slug">) => Promise<void>;
}) {
	const readOnly = workflow.isBuiltin;
	const [draft, setDraft] = useState<Draft>(() => draftFromWorkflow(workflow));
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	// Re-seed the draft when the row changes underneath us (our own save bumps
	// rowVersion, or another device edits it). Mid-edit clobbering is acceptable
	// at single-user scale and keeps the form honest to the synced row.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-init only on identity/version change
	useEffect(() => {
		setDraft(draftFromWorkflow(workflow));
	}, [workflow.slug, workflow.rowVersion]);

	const eventTypes = EVENT_TYPES_BY_SOURCE[
		draft.eventSource
	] as readonly string[];

	// The event trigger source must be inside a non-empty allowed-integration
	// cap, or the run can't act on what fired it (server rejects this too).
	const eventCapViolation =
		draft.kind === "event" &&
		draft.allowed.length > 0 &&
		!draft.allowed.includes(draft.eventSource);

	const cronEmpty = draft.kind === "cron" && draft.cronSchedule.trim() === "";
	const cronInvalid =
		draft.kind === "cron" &&
		!cronEmpty &&
		!isLikelyValidWorkflowCron(draft.cronSchedule);
	const timezoneInvalid =
		draft.kind === "cron" &&
		draft.cronTimezone.trim() !== "" &&
		!isValidTimezone(draft.cronTimezone.trim());
	const nameEmpty = draft.name.trim() === "";
	const invalid =
		nameEmpty || cronEmpty || cronInvalid || timezoneInvalid || eventCapViolation;

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
				<div className="flex items-center gap-2 rounded-xl bg-vs-bg-2 px-3 py-2 text-xs text-vs-fg-3">
					<Lock size={13} />
					Built-in workflow — definition is managed by Alfred and can't be
					edited here.
				</div>
			) : null}

			<VsCard>
				<label
					className="text-sm font-medium text-vs-fg-4"
					htmlFor="vs-workflow-name"
				>
					Name
				</label>
				<VsInput
					id="vs-workflow-name"
					value={draft.name}
					readOnly={readOnly}
					onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
					className="mt-3"
					aria-label="Workflow name"
				/>
				{nameEmpty && !readOnly ? (
					<p className="mt-2 text-xs text-vs-red-4">Name is required.</p>
				) : null}
			</VsCard>

			<VsCard>
				<div className="flex flex-wrap items-center gap-3">
					<span className="text-sm font-medium text-vs-fg-4">When</span>
					<VsSegmented<TriggerKind>
						value={draft.kind}
						onValueChange={(kind) =>
							!readOnly && setDraft((d) => ({ ...d, kind }))
						}
						items={TRIGGER_TABS}
						label="When this workflow runs"
					/>
				</div>

				{draft.kind === "cron" ? (
					<div className="mt-4 space-y-3">
						<div className="flex flex-wrap items-center gap-2 text-sm text-vs-fg-4">
							<span className="text-vs-fg-3">Cron</span>
							<VsInput
								value={draft.cronSchedule}
								readOnly={readOnly}
								onChange={(e) =>
									setDraft((d) => ({ ...d, cronSchedule: e.target.value }))
								}
								className="w-44 font-mono"
								placeholder="0 8 * * *"
								aria-label="Cron expression"
							/>
							<span className="text-vs-fg-3">timezone</span>
							<VsInput
								value={draft.cronTimezone}
								readOnly={readOnly}
								onChange={(e) =>
									setDraft((d) => ({ ...d, cronTimezone: e.target.value }))
								}
								className="w-48"
								placeholder="UTC (or America/New_York)"
								aria-label="Cron timezone"
							/>
						</div>
						<p className="text-xs text-vs-fg-3">
							Standard 5-field cron. Leave timezone blank to inherit your
							account timezone.
						</p>
						{cronInvalid ? (
							<p className="text-xs text-vs-red-4">
								Use a valid 5-field cron expression.
							</p>
						) : null}
						{timezoneInvalid ? (
							<p className="text-xs text-vs-red-4">
								Use a valid IANA timezone, or leave it blank.
							</p>
						) : null}
					</div>
				) : null}

				{draft.kind === "event" ? (
					<div className="mt-4 space-y-3">
						<div className="flex flex-wrap items-center gap-2 text-sm text-vs-fg-4">
							<span className="text-vs-fg-3">On</span>
							<VsSegmented<AuthorableEventSource>
								value={draft.eventSource}
								onValueChange={(eventSource) =>
									!readOnly &&
									setDraft((d) => ({
										...d,
										eventSource,
										eventType:
											(
												EVENT_TYPES_BY_SOURCE[eventSource] as readonly string[]
											)[0] ?? "",
									}))
								}
								items={AUTHORABLE_EVENT_SOURCE_OPTIONS}
								label="Event source"
							/>
							<span className="text-vs-fg-3">when</span>
							<VsSegmented<string>
								value={draft.eventType}
								onValueChange={(eventType) =>
									!readOnly && setDraft((d) => ({ ...d, eventType }))
								}
								items={eventTypes.map((t) => ({
									value: t,
									label: eventTypeLabel(t),
								}))}
								label="Event type"
							/>
						</div>
						<p className="text-xs text-vs-fg-3">
							Alfred runs this workflow each time the selected event arrives,
							with the triggering item passed in as context.
						</p>
					</div>
				) : null}

				{draft.kind === "manual" ? (
					<p className="mt-4 text-xs leading-5 text-vs-fg-3">
						This workflow only runs when you trigger it with{" "}
						<strong>Run now</strong>. No schedule or event.
					</p>
				) : null}
			</VsCard>

			<VsCard>
				<label
					className="text-sm font-medium text-vs-fg-4"
					htmlFor="vs-workflow-prompt"
				>
					Prompt
				</label>
				<VsTextarea
					id="vs-workflow-prompt"
					value={draft.brief}
					readOnly={readOnly}
					onChange={(e) => setDraft((d) => ({ ...d, brief: e.target.value }))}
					className="mt-3 min-h-[152px]"
					placeholder="Describe what Alfred should do. Mention integrations with @gmail, @calendar, …"
					aria-label={`${workflow.name} prompt`}
				/>
			</VsCard>

			<VsCard>
				<div className="flex items-start gap-3">
					<WorkflowIcon tone="purple">
						<Link2 size={16} />
					</WorkflowIcon>
					<div className="min-w-0 flex-1">
						<p className="text-sm font-medium text-vs-fg-4">
							Allowed integrations
						</p>
						<p className="mt-1 text-xs leading-5 text-vs-fg-3">
							The cap on which integrations this workflow may load. Empty means
							unrestricted (any connected integration).
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{LOADABLE_INTEGRATION_SLUGS.map((slug) => {
								const selected = draft.allowed.includes(slug);
								return (
									<VsPill
										key={slug}
										type="button"
										variant={selected ? "accent" : "default"}
										tone={selected ? "purple" : undefined}
										disabled={readOnly}
										onClick={() => toggleAllowed(slug)}
										className={cn(!selected && "opacity-70")}
									>
										{integrationLabel(slug)}
									</VsPill>
								);
							})}
						</div>
					</div>
				</div>
			</VsCard>

			{eventCapViolation ? (
				<div className="flex items-center gap-2 rounded-xl bg-vs-amber-1 px-3 py-2 text-xs text-vs-amber-4">
					<AlertTriangle size={13} />
					Add <strong>{integrationLabel(draft.eventSource)}</strong> to the
					allowed integrations, or clear the cap — an event workflow must be
					allowed to use its own trigger source.
				</div>
			) : null}

			{saveError ? (
				<div className="flex items-center gap-2 rounded-xl bg-vs-red-1 px-3 py-2 text-xs text-vs-red-4">
					<AlertTriangle size={13} />
					{saveError}
				</div>
			) : null}

			{!readOnly ? (
				<div className="flex justify-end">
					<VsButton
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
					</VsButton>
				</div>
			) : null}
		</div>
	);
}
