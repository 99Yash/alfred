import { route, probeRoute, googleLeg, type LanguageModel } from "@alfred/ai";
import {
  buildSystemPrompt,
  listActivityInputSchema,
  type ActivityList,
  type EmailListItem,
  type PriorBriefingSummary,
} from "@alfred/assistant/briefings";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { assertNever, type DayShape } from "@alfred/contracts";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";

/**
 * The briefing composer on fixed tool results: the real system prompt, stub tools, and one
 * `dump_briefing`. The briefing evals share it.
 */

const NOW = new Date("2026-07-03T02:00:00Z");

// ─── Fixtures ────────────────────────────────────────────────────────────────

export function email(
  overrides: Partial<EmailListItem> & Pick<EmailListItem, "from" | "subject">,
): EmailListItem {
  return {
    documentId: overrides.documentId ?? "doc_eval_1",
    subject: overrides.subject,
    from: overrides.from,
    snippet: overrides.snippet ?? null,
    // `null` is an unlabelled mail, so only an absent value takes the default.
    triageCategory:
      overrides.triageCategory === undefined ? "action_needed" : overrides.triageCategory,
    triageRationale: overrides.triageRationale ?? null,
    authoredAt: overrides.authoredAt ?? NOW,
    ingestedAt: overrides.ingestedAt ?? NOW,
    receivedAtLocal: overrides.receivedAtLocal ?? null,
    unread: overrides.unread ?? null,
    threadId: overrides.threadId ?? "thr_eval_1",
    previouslySurfaced: overrides.previouslySurfaced ?? true,
    attentionBand: overrides.attentionBand ?? "normal",
    contentLength: overrides.contentLength ?? 240,
    outsideTriage: overrides.outsideTriage ?? null,
  };
}

export interface Scenario {
  label: string;
  priorBriefings: PriorBriefingSummary[];
  emails: EmailListItem[];
  dayShape: DayShape;
}

export type ModelLane = "boss" | "forced-gemini";

export interface ScenarioRun {
  scenario: Scenario;
  modelLane: ModelLane;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface ComposeOutput {
  ok: boolean;
  subject: string;
  bodyText: string;
  bodyMarkdown: string;
  combined: string;
  note: string;
}

const EMPTY_OUTPUT: ComposeOutput = {
  ok: false,
  subject: "",
  bodyText: "",
  bodyMarkdown: "",
  combined: "",
  note: "no dump_briefing",
};

function modelForLane(lane: ModelLane): LanguageModel {
  switch (lane) {
    case "boss":
      return route("boss").model();
    case "forced-gemini":
      return probeRoute(googleLeg("gemini-3.5-flash"), "medium").model();
    default:
      return assertNever(lane, "model lane");
  }
}

export async function runBriefingScenario(input: ScenarioRun): Promise<ComposeOutput> {
  const { scenario, modelLane } = input;
  // An array, not a `let` set inside `execute`: the compiler cannot see a closure assignment, so it
  // narrowed a `let` to `null` and then to `never` after the guard below.
  const dumps: Array<{ subject: string; bodyText: string; bodyMarkdown: string }> = [];

  const system = buildSystemPrompt({
    slot: "morning",
    recipientFirstName: "Yash",
    selfIdentity: selfIdentityGrounding(),
  });

  try {
    await generateText({
      model: modelForLane(modelLane),
      instructions: system,
      messages: [
        {
          role: "user",
          content:
            "Compose the morning briefing for Yash. Start by reading list_prior_briefings, then list_emails_since. End with dump_briefing.",
        },
      ],
      stopWhen: isStepCount(8),
      tools: {
        list_prior_briefings: tool({
          description: "Recent prior briefings, newest first.",
          inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
          execute: async () => scenario.priorBriefings,
        }),
        list_emails_since: tool({
          description:
            "Emails since the last briefing. Each carries subject, from, snippet, triageCategory, previouslySurfaced, attentionBand, and outsideTriage (null for inbox mail that triage labels, else where the unlabelled mail sits). No bodies.",
          inputSchema: z.object({ limit: z.number().int().min(1).max(60).default(60) }),
          execute: async () => scenario.emails,
        }),
        read_email: tool({
          description: "Full body of one email by documentId.",
          inputSchema: z.object({ documentId: z.string() }),
          execute: async ({ documentId }) => {
            const hit = scenario.emails.find((e) => e.documentId === documentId);

            return hit
              ? {
                  documentId,
                  subject: hit.subject,
                  from: hit.from,
                  body: hit.snippet ?? "",
                  truncated: false,
                }
              : { error: `not found: ${documentId}` };
          },
        }),
        list_calendar_events: tool({
          description: "Calendar events in the window.",
          inputSchema: z.object({
            window: z.enum(["today", "today_and_tomorrow", "rest_of_today_and_tomorrow"]),
          }),
          execute: async () => [],
        }),
        get_day_shape: tool({
          description: "Deterministic activity volume + shipped work.",
          inputSchema: z.object({}),
          execute: async () => scenario.dayShape,
        }),
        list_activity: tool({
          description: "The activity record of the connected tools. This scenario has none.",
          inputSchema: listActivityInputSchema,
          execute: async (): Promise<ActivityList> => ({
            status: "listed",
            counts: { user: {}, other: {}, unreadable: 0 },
            matched: 0,
            items: [],
            before: null,
          }),
        }),
        list_action_items: tool({
          description: "Open action items. Not wired — returns [].",
          inputSchema: z.object({ status: z.enum(["open", "any"]).default("open") }),
          execute: async () => [],
        }),
        list_meeting_preps: tool({
          description: "Meeting preps. Not wired — returns [].",
          inputSchema: z.object({
            window: z
              .enum(["today", "tomorrow", "today_and_tomorrow"])
              .default("today_and_tomorrow"),
          }),
          execute: async () => [],
        }),
        dump_briefing: tool({
          description: "Terminal write. Submit the final briefing exactly once.",
          inputSchema: z.object({
            subject: z.string().min(1).max(200),
            bodyText: z.string().min(1),
            bodyMarkdown: z.string().min(1),
            citedDocumentIds: z.array(z.string()).default([]),
            rationale: z.string().nullable().default(null),
          }),
          execute: async (input) => {
            dumps.push({
              subject: input.subject,
              bodyText: input.bodyText,
              bodyMarkdown: input.bodyMarkdown,
            });

            return { ok: true };
          },
        }),
      },
    });
  } catch (err) {
    return {
      ...EMPTY_OUTPUT,
      note: `[${modelLane}] ERROR: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const dumped = dumps.at(-1);

  if (!dumped) return EMPTY_OUTPUT;
  const { subject, bodyText, bodyMarkdown } = dumped;

  return {
    ok: true,
    subject,
    bodyText,
    bodyMarkdown,
    combined: `${subject}\n${bodyText}\n${bodyMarkdown}`,
    note: "",
  };
}
