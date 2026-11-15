import path from "node:path";
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

// Triage slice 2a (`docs/plans/triage-theory-v1.md`): triage does not label spam, so the briefing is
// the only reader that judges it. A real matter in spam goes in the briefing, and the briefing says
// that the mail is in spam, because a Gmail inbox search does not show spam. The two mails are the
// two spam-filed cases of the triage deck. Run with apps/server/.env populated:
// `pnpm --filter server eval briefing-out-of-scope-mail`.

loadEnv({ path: path.resolve(import.meta.dirname, "../.env") });

const QUIET_DAY: DayShape = { activityVolume: "quiet", shipped: [] };

/** Noise around the spam mail: two Promotions-tab mails that triage also did not label. */
const PROMOTIONS_NOISE = [
  email({
    documentId: "doc_chess_promo",
    threadId: "thr_chess_promo",
    from: '"Chess.com" <hello@chess.com>',
    subject: "Use it or Lose it! ⌛",
    snippet: "Use your free Daily Game Review for your game against an opponent!",
    triageCategory: null,
    previouslySurfaced: false,
    outsideTriage: "promotions",
  }),
  email({
    documentId: "doc_webinar",
    threadId: "thr_webinar",
    from: '"Marine @ Arize" <mmeyer@email.arize.com>',
    subject: "Query traces in SQL instead of paging every span",
    snippet: "The database returns the aggregate. Save your spot. Query Phoenix traces with SQL.",
    triageCategory: null,
    previouslySurfaced: false,
    outsideTriage: "promotions",
  }),
];

/** A real ask on the user's own application, which Gmail filed as spam (deck: #1098). */
const RECRUITER_IN_SPAM: Scenario = {
  label: "spam-filed-recruiter-ask-on-the-users-own-application",
  priorBriefings: [],
  emails: [
    email({
      documentId: "doc_recruiter",
      threadId: "thr_recruiter",
      from: "Priya N. <priya@talent.acme-example.com>",
      subject: "Re: Backend Engineer application: next step",
      snippet:
        "Hi Yash, thanks for applying to the Backend Engineer role. The team liked your profile. The next step is a short take-home task; please send it back by Friday 6 pm IST, or tell me if you need more time. Best, Priya",
      triageCategory: null,
      previouslySurfaced: false,
      unread: true,
      outsideTriage: "spam",
    }),
    ...PROMOTIONS_NOISE,
  ],
  dayShape: QUIET_DAY,
};

/** A stranger's sign-this-document link, filed as spam. Phish-shaped: drop it, or say spam. */
const SIGN_INVITE_IN_SPAM: Scenario = {
  label: "spam-filed-sign-this-invite-sent-bcc-style",
  priorBriefings: [],
  emails: [
    email({
      documentId: "doc_sign_invite",
      threadId: "thr_sign_invite",
      from: "H. Blake <h.blake@studio-example.com>",
      subject:
        "Invitation: Studio Project Collaboration @ Tue Nov 10, 2026 4pm - 5pm (EDT) (H. Blake)",
      snippet:
        "H. Blake from Studio sent you an invitation, please review and sign. Review Document <https://app.powerbi.com/view?r=REDACTED>",
      triageCategory: null,
      previouslySurfaced: false,
      unread: true,
      outsideTriage: "spam",
    }),
    ...PROMOTIONS_NOISE,
  ],
  dayShape: QUIET_DAY,
};

const SAYS_SPAM = /\bspam\b/i;

function failed(output: ComposeOutput, input: ScenarioRun) {
  return { score: 0, metadata: `[${input.scenario.label}] compose failed: ${output.note}` };
}

evalite<ScenarioRun, ComposeOutput, null>(
  "Briefing reports a real ask in spam and says it is in spam (slice 2a)",
  {
    data: () => [
      { input: { scenario: RECRUITER_IN_SPAM, modelLane: "boss" as const }, expected: null },
    ],
    task: (input) => runBriefingScenario(input),
    scorers: [
      {
        name: "Names the ask",
        scorer: ({ output, input }) => {
          if (!output.ok) return failed(output, input);
          const named = /priya|take-home|backend engineer/i.test(output.combined);

          return {
            score: named ? 1 : 0,
            metadata: named
              ? `surfaced the recruiter ask. subject="${output.subject}"`
              : `dropped the real ask in spam: ${output.combined.slice(0, 300)}`,
          };
        },
      },
      {
        name: "Says it is in spam",
        scorer: ({ output, input }) => {
          if (!output.ok) return failed(output, input);
          const says = SAYS_SPAM.test(output.combined);

          return {
            score: says ? 1 : 0,
            metadata: says
              ? "says the mail is in spam"
              : `does not say spam: ${output.combined.slice(0, 300)}`,
          };
        },
      },
    ],
  },
);

evalite<ScenarioRun, ComposeOutput, null>(
  "Briefing drops a phish-shaped ask in spam, or says it is in spam (slice 2a)",
  {
    data: () => [
      { input: { scenario: SIGN_INVITE_IN_SPAM, modelLane: "boss" as const }, expected: null },
    ],
    task: (input) => runBriefingScenario(input),
    scorers: [
      {
        name: "Dropped, or named with spam",
        scorer: ({ output, input }) => {
          if (!output.ok) return failed(output, input);
          const named = /\b(?:blake|studio)\b/i.test(output.combined);
          const ok = !named || SAYS_SPAM.test(output.combined);

          return {
            score: ok ? 1 : 0,
            metadata: !named
              ? `dropped the invite. subject="${output.subject}"`
              : ok
                ? "named the invite and said spam"
                : `named the invite without saying spam: ${output.combined.slice(0, 300)}`,
          };
        },
      },
    ],
  },
);
