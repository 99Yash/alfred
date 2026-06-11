/**
 * One-shot validation for the rule-12e activity-feed/task-tracker fix.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smoke-triage-clickup.ts
 *
 * Live cheap-model (gemini-2.5-flash-lite) call — needs GOOGLE_GENERATIVE_AI_API_KEY.
 * Runs the real prod miss plus two counter-cases that must NOT be suppressed, so
 * we confirm the new principle flips the leak without over-correcting genuine work.
 */
import { classifyEmail } from "@alfred/api/modules/triage/classify";
import { extractSenderContext } from "@alfred/api/modules/triage/sender-context";
import type { Observations } from "@alfred/api/modules/triage/observations";

const baseObs = (over: Partial<Observations> = {}): Observations => ({
  senderPrior: { key: "service:tasks.clickup.com", categoryCounts: {}, lastCategory: null },
  persona: "work",
  thread: { lastUserReplyAt: null, newestDirection: "received", messageCount: 0 },
  knownContact: false,
  gmail: { categories: ["updates"], important: false, starred: false, inInbox: true },
  content: {
    hasUnsubscribe: false,
    hasCurrencyAmount: false,
    hasSecurityKeyword: false,
    hasCalendarInvite: false,
    hasInvestorNotice: false,
    hasPublicEventLanguage: false,
  },
  ...over,
});

interface Case {
  name: string;
  from: string;
  subject: string;
  body: string;
  expectCategory: string[];
  expectTodo: boolean;
  /** A heavy action_needed prior, like prod accumulated — proves the prompt beats the prior. */
  prior?: Record<string, number>;
}

const CASES: Case[] = [
  {
    name: "REAL MISS — third-party closure comment",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Conservice : Fix deal views resetting to open deals after saving and ensure filters persist",
    body: "Akshay Jyothis commented\nNothing to be done here - was a product understanding gap for the user\nView comment or reply to add a comment",
    expectCategory: ["fyi", "done"],
    expectTodo: false,
    prior: { action_needed: 20, done: 6, fyi: 2 },
  },
  {
    name: "COUNTER — task assigned to the user (must stay action_needed + todo)",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Fix login redirect loop on SSO",
    body: "Akshay Jyothis assigned this task to you.\nDue Jun 14. Priority: High.\nThe SSO login redirects in a loop for enterprise accounts.",
    expectCategory: ["action_needed"],
    expectTodo: true,
    prior: { action_needed: 20, done: 6, fyi: 2 },
  },
  {
    name: "COUNTER — direct @mention question (reply owed by user)",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Deal Merge Flow",
    body: "Akshay Jyothis mentioned you in a comment\n@yash.k can you confirm whether the merge dedupes by external id before we ship? Need your call today.",
    expectCategory: ["action_needed", "awaiting_reply"],
    expectTodo: true,
    prior: { action_needed: 20, done: 6, fyi: 2 },
  },
];

async function main() {
  let failures = 0;
  for (const c of CASES) {
    const { context: senderContext } = extractSenderContext({
      fromHeader: c.from,
      subject: c.subject,
      body: c.body,
    });
    const { classification, model } = await classifyEmail({
      identity: { name: "Yash", email: "yash.k@oliv.ai" },
      document: {
        id: "smoke",
        title: c.subject,
        content: `From: ${c.from}\nTo: yash.k@oliv.ai\nSubject: ${c.subject}\n\n${c.body}`,
        authoredAt: new Date("2026-06-11T09:51:48Z"),
        metadata: { from: c.from, to: "yash.k@oliv.ai", labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"] },
      },
      senderContext,
      observations: baseObs({
        senderPrior: { key: "service:tasks.clickup.com", categoryCounts: c.prior ?? {}, lastCategory: "action_needed" },
      }),
    });
    const gotTodo = classification.todoDecision?.outcome === "proposed";
    const catOk = c.expectCategory.includes(classification.category);
    const todoOk = gotTodo === c.expectTodo;
    const ok = catOk && todoOk;
    if (!ok) failures++;
    console.log(`\n${ok ? "✅" : "❌"} ${c.name}`);
    console.log(`   category: ${classification.category} (want ${c.expectCategory.join("|")}) ${catOk ? "ok" : "WRONG"} · model=${model}`);
    console.log(`   todo: ${gotTodo ? `proposed "${classification.todoSuggestion?.name}"` : `none (${classification.todoDecision?.outcome})`} (want ${c.expectTodo ? "todo" : "none"}) ${todoOk ? "ok" : "WRONG"}`);
    console.log(`   rationale: ${classification.rationale}`);
  }
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
