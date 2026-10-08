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
 * Input-aware card titles, e.g. "Email maya@…" instead of "Send draft".
 * Other tools use `humanizeToolName`. Decision actions stay uniform (ADR-0034).
 */
const TITLE_OVERRIDES = new Map<ToolName, (input: JsonObject) => string>([
  [
    "gmail.send_draft",
    (input) => {
      // The schema's preprocessors normalize `to`; an unfinished input fails the
      // parse and gets the generic title.
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

/** The input-aware override, else the humanized tool name. */
export function cardTitle(toolName: ToolName, input: unknown): string {
  const record = asRecord(input);
  const override = TITLE_OVERRIDES.get(toolName);

  if (override && record) return override(record);

  return capitalize(humanizeToolName(toolName));
}

/** "Send a Gmail draft", never the raw `gmail.send_draft`. */
export function toolChipLabel(toolName: ToolName): string {
  return capitalize(humanizeToolName(toolName));
}
