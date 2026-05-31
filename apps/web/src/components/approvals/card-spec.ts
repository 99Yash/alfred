import { humanizeToolName, type ToolName } from "@alfred/contracts";
import { formatDateTime, stringArray, stringValue } from "./format";

export interface Field {
  label: string;
  value: string;
  multiline?: boolean;
}

/**
 * Per-(integration, action) card behaviour, keyed by `ToolName`. Each spec
 * owns an optional input-aware `title` and the structured `fields` layout.
 * The card body is integration-specific; the four decision actions are NOT —
 * they stay uniform across every tool (grilled 2026-05-31, ADR-0034).
 *
 * A tool without an entry falls back to the contracts `humanizeToolName`
 * title + a raw-JSON body, so new tools render safely before anyone designs a
 * bespoke card. Keys are type-checked against `ToolName`, so they can't drift
 * from the real tool surface. Server runtime values never cross into this
 * bundle — only the structural input shape.
 */
export interface ApprovalCardSpec {
  /** Input-aware title; omit to use the generic humanized tool name. */
  title?: (input: Record<string, unknown>) => string;
  fields: (input: Record<string, unknown>) => Field[];
}

const CARD_SPECS: Partial<Record<ToolName, ApprovalCardSpec>> = {
  "gmail.send_draft": {
    title: (input) => {
      const to = stringArray(input.to);
      if (to.length === 0) return "Send a Gmail draft";
      const rest = to.length > 1 ? ` +${to.length - 1}` : "";
      return `Email ${to[0]}${rest}`;
    },
    fields: (input) => [
      { label: "To", value: stringArray(input.to).join(", ") },
      { label: "Cc", value: stringArray(input.cc).join(", ") },
      { label: "Subject", value: stringValue(input.subject) },
      { label: "Thread", value: stringValue(input.threadId) },
      { label: "Body", value: stringValue(input.bodyText), multiline: true },
    ],
  },
  "calendar.create_event": {
    title: (input) => {
      const summary = stringValue(input.summary);
      return summary ? `Schedule “${summary}”` : "Create a calendar event";
    },
    fields: (input) => [
      { label: "Summary", value: stringValue(input.summary) },
      { label: "Start", value: formatDateTime(stringValue(input.start)) },
      { label: "End", value: formatDateTime(stringValue(input.end)) },
      { label: "Attendees", value: stringArray(input.attendees).join(", ") },
      { label: "Description", value: stringValue(input.description), multiline: true },
    ],
  },
};

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Human card title: the spec's input-aware title when present, else the
 * shared contracts humanizer (capitalized to read as a title).
 */
export function cardTitle(toolName: ToolName, input: unknown): string {
  const record = asRecord(input);
  const spec = CARD_SPECS[toolName];
  if (spec?.title && record) return spec.title(record);
  return capitalize(humanizeToolName(toolName));
}

/** Structured fields for the tool, or `null` to fall back to a raw-JSON body. */
export function cardFields(toolName: ToolName, input: unknown): Field[] | null {
  const record = asRecord(input);
  const spec = CARD_SPECS[toolName];
  return spec && record ? spec.fields(record) : null;
}
