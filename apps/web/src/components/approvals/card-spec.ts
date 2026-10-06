import {
  calendarCreateEventInput,
  gmailSendDraftInput,
  humanizeToolName,
  type JsonObject,
  type ToolName,
} from "@alfred/contracts";
import { asRecord } from "~/lib/json-record";
import { capitalize } from "~/lib/strings";

/**
 * Input-aware card titles. The card *body* (the field layout) is now derived
 * from each tool's schema — see `toolInputFields` / `ApprovalInputEditor` — so
 * the only per-tool customization left here is the headline: e.g. an email reads
 * "Email maya@…" rather than the generic "Send draft". Tools without an entry
 * use the shared `humanizeToolName`, so new tools title themselves safely.
 *
 * The four decision actions are NOT customized; they stay uniform across every
 * tool (grilled 2026-05-31, ADR-0034).
 */
const TITLE_OVERRIDES = new Map<ToolName, (input: JsonObject) => string>([
  [
    "gmail.send_draft",
    (input) => {
      // The input schema's preprocessors fold the model's two habits — a bare
      // recipient string, a `body` for `bodyText` — before validation, so a
      // successful parse reads `to` as the string array the title needs. A
      // failed parse (a staged input the model hasn't finished shaping) falls
      // back to the generic title rather than guessing off raw leaves.
      const parsed = gmailSendDraftInput.safeParse(input);

      if (!parsed.success) return "Send a Gmail draft";
      const [first, ...rest] = parsed.data.to;

      if (!first) return "Send a Gmail draft";
      const suffix = rest.length > 0 ? ` +${rest.length}` : "";

      return `Email ${first}${suffix}`;
    },
  ],
  [
    "calendar.create_event",
    (input) => {
      const parsed = calendarCreateEventInput.safeParse(input);

      if (!parsed.success) return "Create a calendar event";

      return `Schedule “${parsed.data.summary}”`;
    },
  ],
]);

/**
 * Human card title: the tool's input-aware override when present, else the
 * shared contracts humanizer (capitalized to read as a title).
 */
export function cardTitle(toolName: ToolName, input: unknown): string {
  const record = asRecord(input);
  const override = TITLE_OVERRIDES.get(toolName);

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
