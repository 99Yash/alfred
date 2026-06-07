import { humanizeToolName, type ToolName } from "@alfred/contracts";
import { asRecord } from "~/lib/json-record";
import { stringArray, stringValue } from "./format";

/**
 * Input-aware card titles. The card *body* (the field layout) is now derived
 * from each tool's schema — see `toolInputFields` / `InputRenderer` — so the
 * only per-tool customization left here is the headline: e.g. an email reads
 * "Email maya@…" rather than the generic "Send draft". Tools without an entry
 * use the shared `humanizeToolName`, so new tools title themselves safely.
 *
 * The four decision actions are NOT customized; they stay uniform across every
 * tool (grilled 2026-05-31, ADR-0034).
 */
const TITLE_OVERRIDES: Partial<Record<ToolName, (input: Record<string, unknown>) => string>> = {
  "gmail.send_draft": (input) => {
    const to = stringArray(input.to);
    if (to.length === 0) return "Send a Gmail draft";
    const rest = to.length > 1 ? ` +${to.length - 1}` : "";
    return `Email ${to[0]}${rest}`;
  },
  "calendar.create_event": (input) => {
    const summary = stringValue(input.summary);
    return summary ? `Schedule “${summary}”` : "Create a calendar event";
  },
};

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Human card title: the tool's input-aware override when present, else the
 * shared contracts humanizer (capitalized to read as a title).
 */
export function cardTitle(toolName: ToolName, input: unknown): string {
  const record = asRecord(input);
  const override = TITLE_OVERRIDES[toolName];
  if (override && record) return override(record);
  return capitalize(humanizeToolName(toolName));
}

/**
 * Human label for the tool-provenance chip — "Send a Gmail draft", never the
 * raw `gmail.send_draft` symbol. Raw tool names are a developer artifact and
 * don't belong on user-facing approval surfaces.
 */
export function toolChipLabel(toolName: ToolName): string {
  return capitalize(humanizeToolName(toolName));
}
