import path from "node:path";
import { google } from "@ai-sdk/google";
import { getBossModel, type LanguageModel } from "@alfred/ai";
import { withToolNameShim } from "@alfred/ai/tool-name-shim";
import type { EmailListItem, PriorBriefingSummary } from "@alfred/api";
import type { DayShape } from "@alfred/contracts";
import { generateText, stepCountIs, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import { z } from "zod";
import { buildSystemPrompt } from "../src/builtins/agents/briefing/prompt";

// #265 — the briefing composer must NOT assert a progress/status claim ("still
// no reply", "no progress", "you haven't started X") on an item that arrived as
// a *machine notification* from a collaboration tool (ClickUp / Slack / Linear /
// GitHub). The work on those items happens in the tool or the IDE, never in a
// reply to the notification email, so email-thread silence is zero evidence of
// task progress. The correct move is a neutral open reminder. The prompt fix
// adds that principle; this eval pins it so a future prompt edit or model swap
// can't silently regress back to fabricating "no progress" on a bot thread.
//
// Two blocks:
//   A. machine-notification threads → composed text carries NO asserted-progress
//      phrasing (the bug).
//   B. a genuine person-to-person reply-owed thread → the composer STILL surfaces
//      the person (the fix must not over-correct and gag legitimate "waiting on
//      you" items).
//
// Runs both the production boss getter and a forced Gemini fallback-model
// variant through the real prompt + fixture-backed briefing tool loop. #265 was
// observed on the fallback model, while Sonnet can pass without the prompt fix,
// so the forced-Gemini lane is load-bearing.
//
// Run locally with apps/server/.env populated (GOOGLE_GENERATIVE_AI_API_KEY):
//   pnpm --filter server eval

loadEnv({ path: path.resolve(import.meta.dirname, "../.env") });

const NOW = new Date("2026-07-03T02:00:00Z");
const YESTERDAY_MORNING = new Date("2026-07-02T02:30:00Z");

/**
 * Phrasings that assert a progress/status/reply-owed CLAIM. Deliberately tight
 * so a legitimate neutral reminder ("open task", "still assigned to you",
 * "you're assigned") does NOT match — only fabricated-state claims do.
 */
const ASSERTED_PROGRESS_PATTERNS: RegExp[] = [
  /still\s+no\s+repl/i,
  /\bno\s+repl(?:y|ies)\b/i,
  /\bno\s+progress\b/i,
  /\bno\s+movement\b/i,
  /\bno\s+response\s+(?:yet|from\s+you)\b/i,
  /\bno\s+word\s+(?:back|yet)\b/i,
  /(?:haven'?t|hasn'?t|have\s+not|has\s+not)\s+(?:yet\s+)?(?:started|begun|responded|replied|gotten|made\s+progress)/i,
  /\bstill\s+(?:waiting|haven'?t|hasn'?t|open\s+with\s+no)\b/i,
  /\b(?:still\s+)?waiting\s+on\s+you\b/i,
  /\bblocked\s+on\s+you\b/i,
  /\bstalled\b/i,
  /\bneeds\s+your\s+(?:reply|response|update)\b/i,
  /\bno\s+update\s+from\s+you\b/i,
  /\byou\s+still\s+owe\b/i,
  /\bawaiting\s+(?:your\s+)?repl/i,
  /\bhasn'?t\s+heard\s+back\b/i,
  /\bhave(?:n'?t| not)\s+heard\s+back\b/i,
];

function findAssertedProgress(text: string): string[] {
  return ASSERTED_PROGRESS_PATTERNS.map((re) => text.match(re)?.[0])
    .filter((m): m is string => Boolean(m))
    .map((m) => m.trim());
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function email(overrides: Partial<EmailListItem> & Pick<EmailListItem, "from" | "subject">): EmailListItem {
  return {
    documentId: "doc_eval_1",
    subject: overrides.subject,
    from: overrides.from,
    snippet: overrides.snippet ?? null,
    triageCategory: overrides.triageCategory ?? "action_needed",
    triageRationale: overrides.triageRationale ?? null,
    authoredAt: overrides.authoredAt ?? NOW,
    ingestedAt: overrides.ingestedAt ?? NOW,
    receivedAtLocal: overrides.receivedAtLocal ?? null,
    unread: overrides.unread ?? null,
    threadId: overrides.threadId ?? "thr_eval_1",
    previouslySurfaced: overrides.previouslySurfaced ?? true,
    attentionBand: overrides.attentionBand ?? "normal",
    contentLength: overrides.contentLength ?? 240,
  };
}

const QUIET_DAY: DayShape = { activityVolume: "quiet", shipped: [] };

interface Scenario {
  label: string;
  priorBriefings: PriorBriefingSummary[];
  emails: EmailListItem[];
  dayShape: DayShape;
}

type ModelLane = "boss" | "forced-gemini";

interface ScenarioRun {
  scenario: Scenario;
  modelLane: ModelLane;
}

function priorMorning(subject: string, bodyText: string): PriorBriefingSummary {
  return {
    id: "brg_eval_prior",
    slot: "morning",
    briefingDate: "2026-07-02",
    runAt: YESTERDAY_MORNING,
    subject,
    bodyText,
  };
}

// Each machine case: one notification-driven item that was ALREADY surfaced in a
// prior briefing (so the composer is tempted to "close the loop" — the exact
// spot the "still no reply / no progress" fabrication comes from), nothing else
// competing, quiet day. A correct briefing either drops it or reminds neutrally.
const MACHINE_CASES: Scenario[] = [
  {
    label: "clickup-task-assignment",
    priorBriefings: [
      priorMorning(
        "Netsmart task assigned",
        "Morning, Yash. Sakshi assigned you the Netsmart group-by task in ClickUp — worth a look today.",
      ),
    ],
    emails: [
      email({
        from: "Oliv AI via ClickUp <notifications@tasks.clickup.com>",
        subject: "Reminder: 'Netsmart group-by' is assigned to you",
        snippet:
          "Sakshi Jindal assigned you the task 'Netsmart group-by'. Current status: In Progress. Open in ClickUp to update.",
        triageCategory: "action_needed",
      }),
    ],
    dayShape: QUIET_DAY,
  },
  {
    label: "slack-mention",
    priorBriefings: [
      priorMorning(
        "Conservice deploy ask",
        "Morning. Someone pinged you in #engineering about taking the Conservice deploy.",
      ),
    ],
    emails: [
      email({
        from: "Slack <notifications@slack.com>",
        subject: "New mention in #engineering",
        snippet: "@yash can you own the Conservice deploy this week? — sent via Slack",
        triageCategory: "action_needed",
        threadId: "thr_slack_1",
      }),
    ],
    dayShape: QUIET_DAY,
  },
  {
    label: "github-issue-assignment",
    priorBriefings: [
      priorMorning(
        "Issue #353 assigned",
        "Morning. You were assigned issue #353 on the alfred repo — the todo-rail one.",
      ),
    ],
    emails: [
      email({
        from: "GitHub <notifications@github.com>",
        subject: "[99Yash/alfred] Issue #353 assigned to you",
        snippet: "You were assigned issue #353 (todo rail is a graveyard). — via GitHub",
        triageCategory: "action_needed",
        threadId: "thr_gh_1",
      }),
    ],
    dayShape: QUIET_DAY,
  },
];

// Control: a genuine human wrote and is waiting on the user. The fix must not
// suppress this — the composer should still surface Fabian by name.
const PERSON_CASE: Scenario = {
  label: "person-to-person-reply-owed",
  priorBriefings: [
    priorMorning(
      "Fabian waiting on redlines",
      "Morning. Fabian is waiting on your sign-off on the contract redlines.",
    ),
  ],
  emails: [
    email({
      from: "Fabian Roberts <fabian@acme.com>",
      subject: "Re: contract redlines — your thoughts?",
      snippet:
        "Circling back — did you get a chance to look at the redlines I sent? I need your sign-off before I can send them to legal.",
      triageCategory: "awaiting_reply",
      previouslySurfaced: true,
      attentionBand: "demanding",
      threadId: "thr_fabian_1",
    }),
  ],
  dayShape: QUIET_DAY,
};

// ─── Runner ──────────────────────────────────────────────────────────────────

interface ComposeOutput {
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
      return getBossModel();
    case "forced-gemini":
      return withToolNameShim(google("gemini-2.5-pro"));
    default: {
      const _exhaustive: never = lane;
      return _exhaustive;
    }
  }
}

async function runBriefingScenario(input: ScenarioRun): Promise<ComposeOutput> {
  const { scenario, modelLane } = input;
  let dumped: { subject: string; bodyText: string; bodyMarkdown: string } | null = null;

  const system = buildSystemPrompt({ slot: "morning", recipientFirstName: "Yash" });

  try {
    await generateText({
      model: modelForLane(modelLane),
      system,
      messages: [
        {
          role: "user",
          content:
            "Compose the morning briefing for Yash. Start by reading list_prior_briefings, then list_emails_since. End with dump_briefing.",
        },
      ],
      stopWhen: stepCountIs(8),
      tools: {
        list_prior_briefings: tool({
          description: "Recent prior briefings, newest first.",
          inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
          execute: async () => scenario.priorBriefings,
        }),
        list_emails_since: tool({
          description:
            "Emails since the last briefing. Each carries subject, from, snippet, triageCategory, previouslySurfaced, attentionBand. No bodies.",
          inputSchema: z.object({ limit: z.number().int().min(1).max(60).default(60) }),
          execute: async () => scenario.emails,
        }),
        read_email: tool({
          description: "Full body of one email by documentId.",
          inputSchema: z.object({ documentId: z.string() }),
          execute: async ({ documentId }) => {
            const hit = scenario.emails.find((e) => e.documentId === documentId);
            return hit
              ? { documentId, subject: hit.subject, from: hit.from, body: hit.snippet ?? "", truncated: false }
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
        list_action_items: tool({
          description: "Open action items. Not wired — returns [].",
          inputSchema: z.object({ status: z.enum(["open", "any"]).default("open") }),
          execute: async () => [],
        }),
        list_meeting_preps: tool({
          description: "Meeting preps. Not wired — returns [].",
          inputSchema: z.object({
            window: z.enum(["today", "tomorrow", "today_and_tomorrow"]).default("today_and_tomorrow"),
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
            dumped = {
              subject: input.subject,
              bodyText: input.bodyText,
              bodyMarkdown: input.bodyMarkdown,
            };
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

  if (!dumped) return EMPTY_OUTPUT;
  const d = dumped as { subject: string; bodyText: string; bodyMarkdown: string };
  return {
    ok: true,
    subject: d.subject,
    bodyText: d.bodyText,
    bodyMarkdown: d.bodyMarkdown,
    combined: `${d.subject}\n${d.bodyText}\n${d.bodyMarkdown}`,
    note: "",
  };
}

// ─── Block A: no fabricated progress on machine-notification threads ─────────

evalite<ScenarioRun, ComposeOutput, null>(
  "Briefing does not assert progress on machine-notification threads (#265)",
  {
    data: () =>
      MACHINE_CASES.flatMap((scenario) =>
        (["boss", "forced-gemini"] as const).map((modelLane) => ({
          input: { scenario, modelLane },
          expected: null,
        })),
      ),
    task: (input) => runBriefingScenario(input),
    scorers: [
      {
        name: "No asserted progress/reply-owed claim on a bot thread",
        scorer: ({ output, input }) => {
          if (!output.ok) {
            // Can't verify a briefing that never composed — score 0 rather than
            // let an errored/empty run pass the negative check for free.
            return {
              score: 0,
              metadata: `[${input.modelLane}/${input.scenario.label}] compose failed: ${output.note}`,
            };
          }
          const hits = findAssertedProgress(output.combined);
          return {
            score: hits.length === 0 ? 1 : 0,
            metadata:
              hits.length === 0
                ? `[${input.modelLane}/${input.scenario.label}] clean — reminder, not assertion. subject="${output.subject}"`
                : `[${input.modelLane}/${input.scenario.label}] fabricated state ${JSON.stringify(hits)} in: ${output.combined.slice(0, 300)}`,
          };
        },
      },
    ],
  },
);

// ─── Block B: person-to-person reply-owed is still surfaced (no over-correction)

evalite<ScenarioRun, ComposeOutput, null>(
  "Briefing still surfaces a genuine person-to-person reply-owed thread (#265 guard)",
  {
    data: () => [{ input: { scenario: PERSON_CASE, modelLane: "boss" as const }, expected: null }],
    task: (input) => runBriefingScenario(input),
    scorers: [
      {
        name: "Surfaces the waiting person by name",
        scorer: ({ output }) => {
          if (!output.ok) return { score: 0, metadata: `compose failed: ${output.note}` };
          const surfaced = /fabian/i.test(output.combined);
          return {
            score: surfaced ? 1 : 0,
            metadata: surfaced
              ? `surfaced Fabian — fix did not over-correct. subject="${output.subject}"`
              : `dropped the person-to-person reply-owed item: ${output.combined.slice(0, 300)}`,
          };
        },
      },
    ],
  },
);
