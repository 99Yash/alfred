import {
  calendarCreateEventInput,
  calendarDeleteEventInput,
  calendarRespondToEventInput,
  calendarUpdateEventInput,
  gmailSendDraftInput,
  type CalendarResponse,
  humanizeToolName,
  isWriteRiskTier,
  type JsonObject,
  mcpCallInput,
  mcpRemoteToolPhrase,
  type ToolName,
  type ToolRiskTier,
  jsonObjectSchema,
} from "@alfred/contracts";
import { capitalize } from "~/lib/strings";

const RESPONSE_VERBS = {
  accepted: "Accept",
  declined: "Decline",
  tentative: "Tentatively accept",
} satisfies Record<CalendarResponse, string>;

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
  [
    "calendar.update_event",
    (input) => {
      const parsed = calendarUpdateEventInput.safeParse(input);

      if (!parsed.success) return "Update a calendar event";

      return `Update “${parsed.data.eventTitle}”`;
    },
  ],
  [
    "calendar.delete_event",
    (input) => {
      const parsed = calendarDeleteEventInput.safeParse(input);

      if (!parsed.success) return "Delete a calendar event";

      return `Delete “${parsed.data.eventTitle}”`;
    },
  ],
  [
    "calendar.respond_to_event",
    (input) => {
      const parsed = calendarRespondToEventInput.safeParse(input);

      if (!parsed.success) return "Answer a calendar invitation";

      return `${RESPONSE_VERBS[parsed.data.response]} “${parsed.data.eventTitle}”`;
    },
  ],
  [
    "mcp.call",
    (input) => {
      const parsed = mcpCallInput.safeParse(input);

      if (!parsed.success) return "Call a connected tool";

      return capitalize(`run ${mcpRemoteToolPhrase(parsed.data.remoteName)}`);
    },
  ],
]);

/** The input-aware override, else the humanized tool name. */
export function cardTitle(toolName: ToolName, input: unknown): string {
  const parsed = jsonObjectSchema.safeParse(input);
  const override = TITLE_OVERRIDES.get(toolName);

  if (override && parsed.success) return override(parsed.data);

  return capitalize(humanizeToolName(toolName));
}

/** "Send a Gmail draft", never the raw `gmail.send_draft`. */
export function toolChipLabel(toolName: ToolName): string {
  return capitalize(humanizeToolName(toolName));
}

/**
 * Short verbs for the approve button, e.g. "Create event". A tool not listed here gets
 * the generic "Approve". Keep each one short enough for a button.
 */
const APPROVE_VERBS = new Map<ToolName, string>([
  ["gmail.send_draft", "Send email"],
  ["gmail.create_draft", "Save draft"],
  ["gmail.modify_thread", "Update labels"],
  ["gmail.modify_message", "Update labels"],
  ["calendar.create_event", "Create event"],
  ["calendar.update_event", "Update event"],
  ["calendar.delete_event", "Delete event"],
  ["calendar.respond_to_event", "Send response"],
  ["sheets.create_spreadsheet", "Create sheet"],
  ["sheets.update_values", "Update cells"],
  ["sheets.append_values", "Add rows"],
  ["sheets.batch_update", "Update sheet"],
  ["sheets.add_sheet", "Add tab"],
  ["slides.create_presentation", "Create deck"],
  ["slides.batch_update", "Update deck"],
  ["slides.add_slide", "Add slide"],
  ["vercel.redeploy", "Redeploy"],
  ["system.activate_workflow", "Activate"],
  // A durable instruction, so "Allow once" would misstate it.
  ["system.remember", "Save instruction"],
]);

/**
 * The approve button's label, shared by the chat dock and the `/approvals` card: the tool's
 * verb ("Create event") when it has one, else the generic label for its tier.
 */
export function approveButtonLabel(
  toolName: ToolName,
  riskTier: ToolRiskTier,
  edited: boolean,
): string {
  if (edited && toolName === "system.activate_workflow") return "Review changes";

  if (edited) return isWriteRiskTier(riskTier) ? "Approve changes" : "Allow changes";

  return APPROVE_VERBS.get(toolName) ?? (isWriteRiskTier(riskTier) ? "Approve" : "Allow once");
}
