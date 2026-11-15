import path from "node:path";
import type { PriorBriefingSummary } from "@alfred/assistant/briefings";
import type { DayShape } from "@alfred/contracts";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import {
  email,
  runBriefingScenario,
  type ComposeOutput,
  type Scenario,
  type ScenarioRun,
} from "./lib/briefing-scenario";

// #265: on a machine notification (ClickUp, Slack, Linear, GitHub), the briefing must not claim
// "no progress". That work happens in the tool, so email silence proves nothing.
// Block A checks bot threads. Block B checks that a real person waiting on a reply still shows.
// The bug appeared on the Gemini fallback, so the forced-Gemini lane matters.
// Run with apps/server/.env populated: `pnpm --filter server eval`.

loadEnv({ path: path.resolve(import.meta.dirname, "../.env") });

const YESTERDAY_MORNING = new Date("2026-07-02T02:30:00Z");

/** Tight on purpose: a neutral reminder like "still assigned to you" must not match. */
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

const QUIET_DAY: DayShape = { activityVolume: "quiet", shipped: [] };

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

// Each item was already in a prior briefing, which tempts a "still no progress" line.
// A correct briefing drops it or gives a neutral reminder.
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

// Control: a real person waits on the user, so Fabian must still appear.
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
            // Score 0, so an empty run does not pass the negative check.
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

// ─── Block B: a real reply-owed thread still shows ───────────────────────────

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
