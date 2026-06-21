import {
  gatherCalendarContribution,
  gatherDayShape,
  listEmailsSinceWatermark,
  listPriorBriefings,
  readEmailDocument,
  type EmailListItem,
  type EmailReadResult,
  type PriorBriefingSummary,
} from "@alfred/api";
import { tool, type ToolSet } from "@alfred/ai";
import type { CalendarContribution, DayShape, IanaTimezone } from "@alfred/contracts";
import { z } from "zod";

/**
 * Narrow toolset for the daily-briefing agent. Two design rules:
 *
 *   1. Safety through architecture, not prompt warnings — there is no
 *      `send_email` / `draft_reply` / general `web_search` tool here.
 *      A tool that doesn't exist can't be misused.
 *
 *   2. Schema-enforced terminal write — the agent must end its loop by
 *      calling `dump_briefing`. Anything else is treated as
 *      not-yet-finished. The body shape is validated at the tool
 *      boundary, not in the prompt, so the renderer always sees a
 *      well-formed payload.
 *
 * `list_calendar_events` is wired to the deterministic calendar
 * contributor (`gatherCalendarContribution`) over the briefing window.
 * The remaining stubs (`list_action_items`, `list_meeting_preps`) return
 * `[]` for now — those contributors still need to be wired. The tool
 * surface is stable so the prompt + agent shell don't change when those
 * land.
 */

export interface BriefingToolBag {
  /** Tool definitions to hand to `generateText`. */
  tools: ToolSet;
  /** Captured result from `dump_briefing` — populated when (if) the agent calls it. */
  getDumped(): DumpedBriefing | null;
}

export interface DumpedBriefing {
  subject: string;
  bodyText: string;
  /**
   * Markdown body. The agent writes prose markdown; the email template
   * (`@alfred/mailer`) owns all styling and renders it to HTML at send
   * time. The model never hand-writes HTML.
   */
  bodyMarkdown: string;
  /** Document ids the agent cited; used for audit logging only. */
  citedDocumentIds: string[];
  /** Free-form one-line gloss for ops logs. */
  rationale: string | null;
}

interface BuildArgs {
  userId: string;
  slot: "morning" | "evening";
  /** Lower bound on `documents.ingested_at` for `list_emails_since`. */
  sinceIngestedAt: Date | null;
  /** Frozen "now" — `until` for the email window. */
  untilIngestedAt: Date;
  /** YYYY-MM-DD calendar date in the user's timezone — anchors the calendar window. */
  briefingDate: string;
  /** User's IANA timezone — defines local day boundaries for the calendar window. */
  timezone: IanaTimezone;
}

/** Fallback day-shape window when this slot has no prior watermark (first run). */
const DAY_MS = 24 * 60 * 60 * 1000;

const dumpInputSchema = z.object({
  subject: z.string().min(1).max(200),
  bodyText: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  citedDocumentIds: z.array(z.string()).default([]),
  rationale: z.string().nullable().default(null),
});

export function buildBriefingTools(args: BuildArgs): BriefingToolBag {
  let dumped: DumpedBriefing | null = null;

  const tools = {
    list_emails_since: tool({
      description:
        "List Gmail emails ingested since the last successful briefing of this slot, up to the frozen 'until' instant. Returns subjects, senders, snippets, triage labels, a previouslySurfaced flag (true = this thread already went out in a recent briefing — treat it as a continuation, not a fresh item), and an attentionBand (demanding | normal | muted) — never full bodies. attentionBand is a precomputed demand ranking: a 'muted' item is recurring machine noise or low-signal that should NOT be surfaced as demanding (e.g. the same alarm fired ten times). Trust it instead of re-judging urgency yourself. Call read_email if you need the body for a specific message.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(60)
          .describe("Max rows to return. Defaults to 60."),
      }),
      execute: async ({ limit }): Promise<EmailListItem[]> => {
        return listEmailsSinceWatermark({
          userId: args.userId,
          sinceIngestedAt: args.sinceIngestedAt,
          untilIngestedAt: args.untilIngestedAt,
          limit,
        });
      },
    }),

    read_email: tool({
      description:
        "Read the body of one email by its document_id (from list_emails_since). Bodies over 8000 chars are truncated; the response flags this. Don't call this for every email — only when the snippet isn't enough to write the briefing.",
      inputSchema: z.object({
        documentId: z.string().describe("Document id from list_emails_since."),
      }),
      execute: async ({ documentId }): Promise<EmailReadResult | { error: string }> => {
        const row = await readEmailDocument({ userId: args.userId, documentId });
        if (!row) return { error: `document not found: ${documentId}` };
        return row;
      },
    }),

    list_prior_briefings: tool({
      description:
        "Read the user's recent prior briefing bodies (both slots interleaved by run time). This is the memory mechanism — an evening briefing should check what morning surfaced so it can close loops naturally; a morning should check yesterday's evening for context.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("How many recent briefings to fetch. Defaults to 5."),
      }),
      execute: async ({ limit }): Promise<PriorBriefingSummary[]> => {
        return listPriorBriefings({ userId: args.userId, limit });
      },
    }),

    list_calendar_events: tool({
      description:
        "List the user's calendar events in the briefing window (today through end of tomorrow; for the evening slot, from now onward). Returns title, start/end, attendees, and location per event. An empty array means either no events in the window or no calendar scope granted — treat it as 'no calendar signal,' not necessarily 'no events.'",
      inputSchema: z.object({
        window: z
          .enum(["today", "today_and_tomorrow", "rest_of_today_and_tomorrow"])
          .describe(
            "Hint for which range you want. The actual window is derived from the briefing slot — morning covers today+tomorrow, evening covers the rest of today+tomorrow.",
          ),
      }),
      execute: async (_input): Promise<CalendarContribution["events"]> => {
        const contribution = await gatherCalendarContribution({
          userId: args.userId,
          briefingDate: args.briefingDate,
          timezone: args.timezone,
          slot: args.slot,
        });
        return contribution?.events ?? [];
      },
    }),

    get_day_shape: tool({
      description:
        "Deterministic read of how active the day actually was: { activityVolume: 'busy'|'normal'|'quiet', shipped: [{title, url}] }, computed from connected-tool activity (GitHub) over the briefing window. Use it to ground the day's tone — NEVER call the day 'quiet' or 'slow' when activityVolume is 'busy' or 'normal'. In the evening slot, `shipped` is the recently-completed work you can recap in one collapsed clause ('a batch of the X work shipped'); never enumerate it.",
      inputSchema: z.object({}),
      execute: async (): Promise<DayShape> => {
        return gatherDayShape({
          userId: args.userId,
          windowStart: args.sinceIngestedAt ?? new Date(args.untilIngestedAt.getTime() - DAY_MS),
          windowEnd: args.untilIngestedAt,
        });
      },
    }),

    list_action_items: tool({
      description:
        "List the user's open action items extracted by the action-items agent. NOT YET WIRED — returns []. The action-items agent (webhook-driven) ships separately.",
      inputSchema: z.object({
        status: z.enum(["open", "any"]).default("open"),
      }),
      execute: async (_input): Promise<unknown[]> => {
        return [];
      },
    }),

    list_meeting_preps: tool({
      description:
        "List meeting prep notes produced by the meeting-prep agent for upcoming external meetings. NOT YET WIRED — returns []. The meeting-prep agent ships separately.",
      inputSchema: z.object({
        window: z.enum(["today", "tomorrow", "today_and_tomorrow"]).default("today_and_tomorrow"),
      }),
      execute: async (_input): Promise<unknown[]> => {
        return [];
      },
    }),

    dump_briefing: tool({
      description:
        "Terminal write. Submit the final composed briefing. Call this exactly once when you're done — calling it ends the loop. subject, bodyText, and bodyMarkdown are all required; cite documentIds for items you referenced inline. The body should be conversational prose (no bullets) and read naturally on its own.",
      inputSchema: dumpInputSchema,
      execute: async (input): Promise<{ ok: true }> => {
        dumped = {
          subject: input.subject,
          bodyText: input.bodyText,
          bodyMarkdown: input.bodyMarkdown,
          citedDocumentIds: input.citedDocumentIds,
          rationale: input.rationale,
        };
        return { ok: true };
      },
    }),
  } as const;

  // Reference args.slot so the linter doesn't complain about the unused
  // destructure — slot lives in the system prompt, not the tools.
  void args.slot;

  return {
    tools,
    getDumped: () => dumped,
  };
}
