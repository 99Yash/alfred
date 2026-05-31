/**
 * Pure formatting helpers for the approvals surface. No React imports — kept
 * separate so the per-component files stay within the single-component lint
 * scope and these stay trivially testable.
 */

import { humanizeSlug } from "@alfred/contracts";

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Human label for the run's narrowed trigger projection — the provenance
 * line's "where did this come from". e.g. `manual` → "Run now",
 * `event`/gmail/message_received → "Triggered by Gmail message".
 */
export function triggerLabel(trigger: {
  kind: string;
  source?: string | null;
  type?: string | null;
}): string {
  switch (trigger.kind) {
    case "manual":
      return "Run now";
    case "cron":
      return "Scheduled";
    case "on_signal":
      return "Signal";
    case "event": {
      const source = trigger.source ? humanizeSlug(trigger.source) : "an event";
      const noun = trigger.type ? humanizeSlug(trigger.type.replace(/_received$/, "")) : "";
      return noun ? `Triggered by ${source} ${noun.toLowerCase()}` : `Triggered by ${source}`;
    }
    default:
      return humanizeSlug(trigger.kind);
  }
}

export function parseJson(value: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 10)}…` : value;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Absolute, human date-time for proposed-input fields (e.g. calendar event
 * start/end). Renders in the viewer's local timezone; falls back to the raw
 * value when it isn't a parseable date, so non-date fields pass through
 * unharmed. Includes the year only when it differs from the current one.
 */
export function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
