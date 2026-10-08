import { gatherCalendarContribution, gatherDayShape } from "../gather";
import {
  listEmailsSinceWatermark,
  listPriorBriefings,
  readEmailDocument,
  type EmailListItem,
  type EmailReadResult,
  type PriorBriefingSummary,
} from "../read";
import { sanitizeVoice } from "@alfred/ai/voice";
import { tool, type ToolSet } from "@alfred/ai";
import type {
  BriefingClosedLoop,
  BriefingLoopRelevance,
  CalendarContribution,
  DayShape,
  IanaTimezone,
} from "@alfred/contracts";
import type { LocalDateKey } from "@alfred/assistant/time";
import { z } from "zod";

/**
 * Narrow toolset for the briefing agent. There is no send, draft, or web search tool:
 * a tool that does not exist cannot be misused. The loop must end in `dump_briefing`,
 * whose schema validates the body. `list_action_items` and `list_meeting_preps` are
 * stubs that return `[]`.
 */

export interface BriefingToolBag {
  tools: ToolSet;
  /** Null until the agent calls `dump_briefing`. */
  getDumped(): DumpedBriefing | null;
}

export interface DumpedBriefing {
  subject: string;
  bodyText: string;
  /** Prose markdown. `@alfred/mailer` renders it; the model never writes HTML. */
  bodyMarkdown: string;
  /** For audit logging only. */
  citedDocumentIds: string[];
  /** One line for ops logs. */
  rationale: string | null;
}

interface BuildArgs {
  userId: string;
  slot: "morning" | "evening";
  /** Lower bound for `list_emails_since`. */
  sinceIngestedAt: Date | null;
  /** Frozen "now". */
  untilIngestedAt: Date;
  /** Anchors the calendar window. */
  briefingDate: LocalDateKey;
  /** Local day boundaries for the calendar window. */
  timezone: IanaTimezone;
  /** Closure facts from gather. */
  closedLoops: BriefingClosedLoop[];
  /** Non-closing verdicts for each live loop. */
  loopRelevance: BriefingLoopRelevance[];
}

/** Day-shape window on the first run, when there is no watermark. */
const DAY_MS = 24 * 60 * 60 * 1000;

const dumpInputSchema = z
  .object({
    subject: z.string().min(1).max(200),
    bodyText: z.string().min(1),
    bodyMarkdown: z.string().min(1),
    citedDocumentIds: z.array(z.string()).default([]),
    rationale: z.string().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const internalTerms = [
      "unverifiable",
      "work-object",
      "work object",
      "object key",
      "deterministic",
      "state category",
      "object state",
      "provider read",
      "relevance verdict",
      "event receipt",
      "native state",
      "payment loop",
      "open loop",
      "live loop",
    ] as const;

    for (const field of ["subject", "bodyText", "bodyMarkdown"] as const) {
      const haystack = value[field].toLowerCase();
      const term = internalTerms.find((candidate) => haystack.includes(candidate));

      if (term) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message:
            `Briefing copy must not expose internal verification terminology (${term}). ` +
            "Rewrite in plain user-facing language or omit the item.",
        });
      }
    }
  });

export function buildBriefingTools(args: BuildArgs): BriefingToolBag {
  let dumped: DumpedBriefing | null = null;

  const tools = {
    list_emails_since: tool({
      description:
        "List Gmail emails ingested since the last successful briefing of this slot, up to the frozen 'until' instant. Returns subjects, senders, snippets, triage labels, a previouslySurfaced flag (true = this item's loop — the thread OR the underlying task/PR it re-notifies about — already went out in a recent briefing; treat it as a continuation, not a fresh item), and an attentionBand (demanding | normal | muted) — never full bodies. Each item also carries receivedAtLocal (the receipt time as wall-clock in the user's timezone, e.g. 'Fri, Jun 26, 3:10 AM' — phrase overnight items by this, not as if they just arrived; null = no timestamp, don't assert a time) and unread (true = still unread, false = the user already opened it, null = unknown — never assume unseen; soften an already-read item away from a fresh 'you need to do X'). attentionBand is a precomputed demand ranking: a 'muted' item is recurring machine noise or low-signal that should NOT be surfaced as demanding (e.g. the same alarm fired ten times). Trust it instead of re-judging urgency yourself. Call read_email if you need the body for a specific message.",
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
          timezone: args.timezone,
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

    list_closed_loops: tool({
      description:
        "List priority-email loops that the deterministic object-state projection positively proved closed. An email absent from this result is not proved closed by this tool and stays live unless get_day_shape.shipped identifies the same object as shipped.",
      inputSchema: z.object({}),
      execute: async (): Promise<BriefingClosedLoop[]> => args.closedLoops,
    }),

    list_loop_relevance: tool({
      description:
        "List one bounded live-read relevance verdict for every still-live priority-email loop, with provider evidence in source, observedState, objectTitle/objectUrl, and detail. Use these rows to calibrate priority and avoid overclaiming, not as a list of items to mention. still-actionable means a trusted live read saw an open or unresolved object; stale-but-open means it saw a resolved, closed, ignored, or draft state and only demotes; unverifiable means no trusted read proved current state and the loop remains live. The verdict names and detail are internal diagnostics: never copy them into user-facing prose, and never turn unverifiable into an ask. No relevance verdict grants closure authority.",
      inputSchema: z.object({}),
      execute: async (): Promise<BriefingLoopRelevance[]> => args.loopRelevance,
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
        "Terminal write. Submit the final composed briefing. Call this exactly once when you're done — calling it ends the loop. subject, bodyText, and bodyMarkdown are all required; cite documentIds for items you referenced inline. The body should be conversational prose (no bullets), read naturally on its own, and contain no internal verification terminology such as 'unverifiable', 'work-object', 'object key', or 'provider read'.",
      inputSchema: dumpInputSchema,
      execute: async (input): Promise<{ ok: true }> => {
        // The model keeps em dashes despite the prompt. This is the one place before persist and send.
        dumped = dumpInputSchema.parse({
          subject: sanitizeVoice(input.subject),
          bodyText: sanitizeVoice(input.bodyText),
          bodyMarkdown: sanitizeVoice(input.bodyMarkdown),
          citedDocumentIds: input.citedDocumentIds,
          rationale: input.rationale,
        });

        return { ok: true };
      },
    }),
  } as const;

  // `slot` is used by the system prompt, not the tools.
  void args.slot;

  return {
    tools,
    getDumped: () => dumped,
  };
}
