/**
 * Pure helpers for the workflow History tab (#561). No React imports so the
 * component files stay single-component and these stay trivially readable.
 */

import {
  humanizeSlug,
  type EffectReceipt,
  type RunStatus,
  type WorkflowRunHistoryRow,
  type WorkflowRunHistoryOutcome,
  type WorkflowRunHistoryTrigger,
} from "@alfred/contracts";
import { formatTimestamp, shortId, triggerLabel } from "~/components/approvals/format";
import type { WorkflowIconTone } from "./workflow-icon";

export interface RunHeadline {
  title: string;
  detail: string | null;
  tone: WorkflowIconTone;
}

const STATUS_TITLE = {
  pending: "Queued",
  runnable: "Queued",
  running: "Running",
  waiting: "Waiting for approval",
  deferred: "Deferred",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
} satisfies Record<RunStatus, string>;

const STATUS_TONE = {
  pending: "muted",
  runnable: "muted",
  running: "purple",
  waiting: "amber",
  deferred: "amber",
  blocked: "amber",
  completed: "green",
  failed: "red",
  cancelled: "muted",
} satisfies Record<RunStatus, WorkflowIconTone>;

function outcomeHeadline(
  outcome: WorkflowRunHistoryOutcome,
  effects: readonly EffectReceipt[],
): RunHeadline {
  switch (outcome.kind) {
    case "completed":
      return { title: "Completed", detail: outcome.summary, tone: "green" };
    case "no_change":
      return { title: "No changes", detail: outcome.summary, tone: "muted" };
    case "deferred":
      return {
        title: "Deferred",
        detail: outcome.retryAt
          ? `${humanizeSlug(outcome.code)}. Retries ${formatTimestamp(outcome.retryAt)}.`
          : humanizeSlug(outcome.code),
        tone: "amber",
      };
    case "blocked":
      return { title: "Blocked", detail: humanizeSlug(outcome.code), tone: "amber" };
    case "failed":
      return { title: "Failed", detail: outcome.safeMessage, tone: "red" };
    case "cancelled": {
      // The live ledger is the one effect list on the wire; nothing lands
      // after the terminal write, so its succeeded count is the frozen one.
      const landed = effects.filter((effect) => effect.outcome === "succeeded").length;
      const unknown = outcome.unknownEffects.length;
      const parts = [
        landed === 0 ? "No write landed before the cancel." : `${landed} write(s) landed first.`,
        unknown > 0 ? `${unknown} write(s) have no observed result.` : null,
      ].filter((part): part is string => part !== null);
      return { title: "Cancelled", detail: parts.join(" "), tone: "muted" };
    }
    case "unknown_write_outcome":
      return {
        title: "Write result unknown",
        detail:
          "A write reached the provider and its result was never observed. Alfred will not retry it.",
        tone: "red",
      };
  }
}

/** What the row says first: the frozen outcome when there is one, else the live status. */
export function runHeadline(row: WorkflowRunHistoryRow): RunHeadline {
  if (row.outcome) return outcomeHeadline(row.outcome, row.effects);
  return { title: STATUS_TITLE[row.status], detail: null, tone: STATUS_TONE[row.status] };
}

/** The exact identity of the firing: the schedule instant, the event id, or the signal. */
export function triggerIdentity(trigger: WorkflowRunHistoryTrigger | null): string {
  if (!trigger) return "Trigger unknown";
  const label = triggerLabel(trigger);
  switch (trigger.kind) {
    case "cron":
      return `${label} for ${formatTimestamp(trigger.scheduledFor)}`;
    case "event":
      return `${label} · ${shortId(trigger.eventId)}`;
    case "on_signal":
      return `${label} · ${trigger.signalName}`;
    case "manual":
      return label;
  }
}

export function revisionLabel(row: WorkflowRunHistoryRow): string {
  if (row.revisionNumber === null) return "Built-in";
  const state = row.isPublished ? "published" : row.isCurrent ? "current" : "superseded";
  return `Revision ${row.revisionNumber} · ${state}`;
}

export function timingLabel(row: WorkflowRunHistoryRow): string {
  const started = formatTimestamp(row.startedAt ?? row.createdAt);
  return row.endedAt ? `${started} → ${formatTimestamp(row.endedAt)}` : started;
}

export interface EffectCount {
  key: "succeeded" | "awaiting" | "rejected" | "failed" | "unknown";
  label: string;
  count: number;
  tone: "green" | "amber" | "red" | "purple";
}

/** Tally the write receipts into the five states a user can act on or worry about. */
export function effectCounts(effects: readonly EffectReceipt[]): EffectCount[] {
  const tally = { succeeded: 0, awaiting: 0, rejected: 0, failed: 0, unknown: 0 };
  for (const effect of effects) {
    if (effect.outcome === "succeeded") tally.succeeded += 1;
    else if (effect.outcome === "awaiting_approval") tally.awaiting += 1;
    else if (effect.status === "rejected" || effect.outcome === "refused") tally.rejected += 1;
    else if (effect.outcome === "failed") tally.failed += 1;
    else if (effect.outcome === "unknown") tally.unknown += 1;
  }
  const all: EffectCount[] = [
    { key: "succeeded", label: "succeeded", count: tally.succeeded, tone: "green" },
    { key: "awaiting", label: "waiting", count: tally.awaiting, tone: "amber" },
    { key: "rejected", label: "rejected", count: tally.rejected, tone: "red" },
    { key: "failed", label: "failed", count: tally.failed, tone: "red" },
    { key: "unknown", label: "unknown", count: tally.unknown, tone: "purple" },
  ];
  return all.filter((entry) => entry.count > 0);
}
