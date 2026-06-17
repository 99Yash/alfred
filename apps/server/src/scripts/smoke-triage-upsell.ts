/**
 * One-shot validation for the rule-11a upsell-vs-owed fix.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smoke-triage-upsell.ts
 *
 * Live cheap-model (gemini-2.5-flash-lite) call — needs GOOGLE_GENERATIVE_AI_API_KEY.
 * Runs the real prod miss (Greptile "upgrade your plan" per-PR bot comment, tagged
 * action_needed @0.8-0.9) plus owed-payment counter-cases that must NOT be demoted,
 * so we confirm the discriminator splits manufactured conversion pressure from a
 * genuine bill without over-suppressing real billing mail.
 */
import { classifyEmail } from "@alfred/api/modules/triage/classify";
import { extractSenderContext } from "@alfred/api/modules/triage/sender-context";
import type { Observations } from "@alfred/api/modules/triage/observations";

const baseObs = (over: Partial<Observations> = {}): Observations => ({
  senderPrior: { key: "service:github.com", categoryCounts: {}, lastCategory: null },
  persona: "personal",
  thread: {
    lastUserReplyAt: null,
    newestDirection: "received",
    messageCount: 0,
    recentMessages: [],
  },
  knownContact: false,
  senderRelationship: null,
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
  to: string;
  persona: "work" | "personal";
  subject: string;
  body: string;
  labelIds: string[];
  expectCategory: string[];
  expectTodo: boolean;
  priorKey: string;
  prior?: Record<string, number>;
  hasCurrencyAmount?: boolean;
}

const CASES: Case[] = [
  {
    name: "REAL MISS — Greptile trial-cap upsell (bot relay), per-PR",
    from: "greptile-apps[bot] <notifications@github.com>",
    to: "yashgouravkar@gmail.com",
    persona: "personal",
    subject: "[99Yash/alfred] greptile-apps[bot] commented on pull request #113",
    body: "99Yash has reached the 50-review limit for trial accounts. To continue receiving code reviews, upgrade your plan: https://app.greptile.com/review/github",
    labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
    expectCategory: ["marketing", "fyi"],
    expectTodo: false,
    priorKey: "service:github.com",
    // The self-reinforcing prior accumulated across PR #111/#112/#113.
    prior: { action_needed: 4, fyi: 2 },
  },
  {
    name: "COUNTER — real failed payment on a paid plan (must stay payment)",
    from: "Stripe <billing@stripe.com>",
    to: "yashgouravkar@gmail.com",
    persona: "personal",
    subject: "Your payment to Vercel failed",
    body: "We were unable to charge your card for your Vercel Pro subscription ($20.00). Update your payment method to avoid service interruption.",
    labelIds: ["UNREAD", "INBOX"],
    expectCategory: ["payment", "urgent", "action_needed"],
    expectTodo: true,
    priorKey: "service:stripe.com",
    hasCurrencyAmount: true,
  },
  {
    name: "COUNTER — owed invoice past due (must stay payment)",
    from: "Linear <billing@linear.app>",
    to: "yash.k@oliv.ai",
    persona: "work",
    subject: "Invoice #4821 is past due",
    body: "Your invoice of $96.00 for the Linear Standard plan is past due. Please pay by Jun 18 to keep your workspace active.",
    labelIds: ["UNREAD", "INBOX"],
    expectCategory: ["payment", "action_needed"],
    expectTodo: true,
    priorKey: "service:linear.app",
    hasCurrencyAmount: true,
  },
  {
    name: "REGRESSION — upsell with a manufactured deadline (prod leak: went urgent)",
    from: "Greptile <hello@greptile.com>",
    to: "yashgouravkar@gmail.com",
    persona: "personal",
    subject: "Greptile trial capped and tracking ends tomorrow",
    body: "Your free trial has hit its review cap. Code-review tracking ends tomorrow — upgrade your plan now to keep receiving reviews.",
    labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
    expectCategory: ["marketing", "fyi"],
    expectTodo: false,
    priorKey: "service:greptile.com",
    // Mirrors the prod prior that helped push it to urgent.
    prior: { action_needed: 3, urgent: 1, fyi: 1 },
  },
  {
    name: "COUNTER — vendor upgrade pitch direct from vendor (must be marketing/fyi)",
    from: "Vercel <hello@vercel.com>",
    to: "yashgouravkar@gmail.com",
    persona: "personal",
    subject: "You're running low on your free Vercel build minutes",
    body: "You've used 80% of your free build minutes this month. Upgrade to Pro to unlock unlimited builds and avoid hitting your limit.",
    labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
    expectCategory: ["marketing", "fyi"],
    expectTodo: false,
    priorKey: "service:vercel.com",
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
      identity: { name: "Yash", email: c.to },
      document: {
        id: "smoke",
        title: c.subject,
        content: `From: ${c.from}\nTo: ${c.to}\nSubject: ${c.subject}\n\n${c.body}`,
        authoredAt: new Date("2026-06-11T09:51:48Z"),
        metadata: { from: c.from, to: c.to, labelIds: c.labelIds },
      },
      senderContext,
      observations: baseObs({
        persona: c.persona,
        senderPrior: { key: c.priorKey, categoryCounts: c.prior ?? {}, lastCategory: null },
        content: {
          hasUnsubscribe: false,
          hasCurrencyAmount: c.hasCurrencyAmount ?? false,
          hasSecurityKeyword: false,
          hasCalendarInvite: false,
          hasInvestorNotice: false,
          hasPublicEventLanguage: false,
        },
      }),
    });
    const gotTodo = classification.todoDecision?.outcome === "proposed";
    const catOk = c.expectCategory.includes(classification.category);
    const todoOk = gotTodo === c.expectTodo;
    const ok = catOk && todoOk;
    if (!ok) failures++;
    console.log(`\n${ok ? "✅" : "❌"} ${c.name}`);
    console.log(
      `   category: ${classification.category} (want ${c.expectCategory.join("|")}) ${catOk ? "ok" : "WRONG"} · model=${model}`,
    );
    console.log(
      `   todo: ${gotTodo ? `proposed "${classification.todoSuggestion?.name}"` : `none (${classification.todoDecision?.outcome})`} (want ${c.expectTodo ? "todo" : "none"}) ${todoOk ? "ok" : "WRONG"}`,
    );
    console.log(`   rationale: ${classification.rationale}`);
  }
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
