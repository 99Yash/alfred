import {
	EVENT_TYPES_BY_SOURCE,
	LOADABLE_INTEGRATION_SLUGS,
} from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import { syncedWorkflowSchema, workflowStatusSchema } from "../schemas";
import type { SyncedWorkflow } from "../types";

export const AUTHORABLE_EVENT_SOURCES = ["gmail"] as const;

function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

const CRON_MONTH_NAMES: Readonly<Record<string, number>> = {
	JAN: 1,
	FEB: 2,
	MAR: 3,
	APR: 4,
	MAY: 5,
	JUN: 6,
	JUL: 7,
	AUG: 8,
	SEP: 9,
	OCT: 10,
	NOV: 11,
	DEC: 12,
};

const CRON_DAY_NAMES: Readonly<Record<string, number>> = {
	SUN: 0,
	MON: 1,
	TUE: 2,
	WED: 3,
	THU: 4,
	FRI: 5,
	SAT: 6,
};

function cronFieldValue(
	value: string,
	names?: Readonly<Record<string, number>>,
): number | null {
	if (/^\d+$/.test(value)) return Number(value);
	return names?.[value.toUpperCase()] ?? null;
}

function isValidCronField(
	field: string,
	min: number,
	max: number,
	names?: Readonly<Record<string, number>>,
): boolean {
	for (const part of field.split(",")) {
		const [range, step] = part.split("/");
		if (!range || (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1))) {
			return false;
		}
		if (range === "*") continue;
		const bounds = range.split("-");
		if (bounds.length > 2) return false;
		const values: number[] = [];
		for (const bound of bounds) {
			const n = cronFieldValue(bound, names);
			if (n === null) return false;
			if (n < min || n > max) return false;
			values.push(n);
		}
		if (values.length === 2 && values[0]! > values[1]!) return false;
	}
	return true;
}

/**
 * Lightweight client/shared guard for normal 5-field cron expressions.
 * Server-side validation uses cron-parser before persisting `active` rows.
 */
export function isLikelyValidWorkflowCron(schedule: string): boolean {
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
	return (
		isValidCronField(minute ?? "", 0, 59) &&
		isValidCronField(hour ?? "", 0, 23) &&
		isValidCronField(dayOfMonth ?? "", 1, 31) &&
		isValidCronField(month ?? "", 1, 12, CRON_MONTH_NAMES) &&
		isValidCronField(dayOfWeek ?? "", 0, 7, CRON_DAY_NAMES)
	);
}

/**
 * Triggers a user may author through the editor (m13 Phase 8).
 *
 * Deliberately narrower than the runtime `workflowTriggerSchema`:
 *   - `on_signal` is omitted (no signal producer exists yet — ADR-0047 8b
 *     deferred); the editor keeps that branch disabled.
 *   - event triggers carry **no `filter`** — the v1 dispatcher does not
 *     evaluate filters, so accepting one would silently lie. The
 *     empty-filter-only contract is enforced here by simply not modelling
 *     the field.
 *   - event `type` must be a known type for the chosen `source`.
 */
export const authorableWorkflowTriggerSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("cron"),
			schedule: z.string().min(1).max(120),
			timezone: z.string().max(64).optional(),
		}),
		z.object({
			kind: z.literal("event"),
			source: z.enum(AUTHORABLE_EVENT_SOURCES),
			type: z.string().min(1),
		}),
		z.object({ kind: z.literal("manual") }),
	])
	.superRefine((trigger, ctx) => {
		if (trigger.kind === "cron") {
			if (!isLikelyValidWorkflowCron(trigger.schedule)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Use a valid 5-field cron expression",
					path: ["schedule"],
				});
			}
			if (trigger.timezone && !isValidTimezone(trigger.timezone)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `'${trigger.timezone}' is not a valid IANA timezone`,
					path: ["timezone"],
				});
			}
			return;
		}
		if (trigger.kind !== "event") return;
		const types = EVENT_TYPES_BY_SOURCE[trigger.source] as readonly string[];
		if (!types.includes(trigger.type)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `'${trigger.type}' is not a valid event type for '${trigger.source}'`,
				path: ["type"],
			});
		}
	});
export type AuthorableWorkflowTrigger = z.infer<
	typeof authorableWorkflowTriggerSchema
>;

/**
 * Patch a user-authored workflow. Every field is optional — the editor
 * sends only what changed. The server mutator re-validates, refuses
 * built-in rows, recomputes `next_run_at` on cron/status changes, and
 * bumps `row_version`.
 */
export const workflowUpdateArgsSchema = z.object({
	slug: z.string().min(1),
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2_000).nullable().optional(),
	brief: z.string().max(20_000).nullable().optional(),
	allowedIntegrations: z
		.array(z.enum(LOADABLE_INTEGRATION_SLUGS))
		.max(32)
		.optional(),
	status: workflowStatusSchema.optional(),
	trigger: authorableWorkflowTriggerSchema.optional(),
});
export type WorkflowUpdateArgs = z.infer<typeof workflowUpdateArgsSchema>;

/**
 * Optimistic patch: merge the defined fields onto the local row and bump
 * `rowVersion`. No-ops if the row is missing (rare post-refresh race) or
 * built-in — the server's authoritative pull takes over either way.
 */
export async function workflowUpdateClient(
	tx: WriteTransaction,
	args: WorkflowUpdateArgs,
): Promise<void> {
	const key = IDB_KEY.WORKFLOW({ id: args.slug });
	const existing = await tx.get(key);
	if (!existing) return;
	const parsed = syncedWorkflowSchema.safeParse(existing);
	if (!parsed.success) return;
	const current = parsed.data;
	if (current.isBuiltin) return;

	const next: SyncedWorkflow = {
		...current,
		...(args.name !== undefined ? { name: args.name } : {}),
		...(args.description !== undefined
			? { description: args.description }
			: {}),
		...(args.brief !== undefined ? { brief: args.brief } : {}),
		...(args.allowedIntegrations !== undefined
			? { allowedIntegrations: args.allowedIntegrations }
			: {}),
		...(args.status !== undefined ? { status: args.status } : {}),
		...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
		rowVersion: current.rowVersion + 1,
	};
	await tx.set(key, normalizeToReadonlyJSON(next));
}
