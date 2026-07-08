/**
 * One-shot validation for the rule-12e activity-feed/task-tracker fix.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smokes/smoke-triage-clickup.ts
 *
 * Live cheap-model (gemini-2.5-flash-lite) call — needs GOOGLE_GENERATIVE_AI_API_KEY.
 * Uses classifyEmail's injected runPass seam so this smoke validates prompt +
 * floor behavior without depending on local `model_prices` / api_call_log DB state.
 * Runs the real prod miss plus two counter-cases that must NOT be suppressed, so
 * we confirm the new principle flips the leak without over-correcting genuine work.
 */
import { getCheapModel } from "@alfred/ai";
import {
  classifyEmail,
  triageClassificationSchema,
  type RunPass,
} from "@alfred/api/modules/triage/classify";
import { extractSenderContext } from "@alfred/api/modules/triage/sender-context";
import {
  clamp01,
  collabActivityPartition,
  toMessage,
  type CollabActivityKind,
} from "@alfred/contracts";
import type { Observations } from "@alfred/api/modules/triage/observations";
import { generateText, Output } from "ai";

const clickUpSenderKind = {
  kind: "service" as const,
  confidence: 0.92,
  evidenceCodes: ["email:local:service_strong"],
  entityId: "ent_clickup",
  displayName: "Oliv AI",
};

const baseObs = (over: Partial<Observations> = {}): Observations => ({
  senderPrior: { key: "notifications@tasks.clickup.com", categoryCounts: {}, lastCategory: null },
  persona: "work",
  thread: {
    lastUserReplyAt: null,
    newestDirection: "received",
    messageCount: 0,
    recentMessages: [],
  },
  knownContact: false,
  senderRelationship: null,
  senderKind: clickUpSenderKind,
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
  expectCollabActivity?: CollabActivityKind | null;
  /** A heavy action_needed prior, like prod accumulated — proves the prompt beats the prior. */
  prior?: Record<string, number>;
  /** Prior messages in the same thread (newest first), fed as ADR-0051 #8 thread context. */
  recentMessages?: { direction: "sent" | "received"; snippet: string }[];
}

const CASES: Case[] = [
  {
    name: "REAL MISS — third-party closure comment",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject:
      "Conservice : Fix deal views resetting to open deals after saving and ensure filters persist",
    body: "Akshay Jyothis commented\nNothing to be done here - was a product understanding gap for the user\nView comment or reply to add a comment",
    expectCategory: ["fyi", "done"],
    expectTodo: false,
    expectCollabActivity: "other_activity",
    prior: { action_needed: 20, done: 6, fyi: 2 },
  },
  {
    name: "COUNTER — task assigned to the user (must stay action_needed + todo)",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Fix login redirect loop on SSO",
    body: "Akshay Jyothis assigned this task to you.\nDue Jun 14. Priority: High.\nThe SSO login redirects in a loop for enterprise accounts.",
    expectCategory: ["action_needed"],
    expectTodo: true,
    expectCollabActivity: "assigned_to_user",
    prior: { action_needed: 20, done: 6, fyi: 2 },
  },
  {
    name: "COUNTER — direct @mention question (reply owed by user)",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Deal Merge Flow",
    body: "Akshay Jyothis mentioned you in a comment\n@yash.k can you confirm whether the merge dedupes by external id before we ship? Need your call today.",
    expectCategory: ["action_needed", "awaiting_reply"],
    expectTodo: true,
    expectCollabActivity: "mentioned_user",
    prior: { action_needed: 20, done: 6, fyi: 2 },
  },
  {
    // The actual prod miss (thread 19ebcefb0663aaa1, 2026-06-12): a bot's
    // "Done. Created [task]" trailing message collapsed a thread whose earlier
    // message assigned the user a bug. With thread context, the live ask wins.
    name: "REAL MISS — bot 'Done. Created task' must NOT bury an earlier assignment (rules 5/12e/17)",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "dvd",
    body: "Brain: Done. Created [Fix imports not triggering deal driver messages] in the 26.3 Backlog list.\nView comment or reply to add a comment",
    expectCategory: ["action_needed", "awaiting_reply"],
    // A live production bug dvd assigned the user (deal-driver messages not
    // firing, manually triggered via repl) — a real obligation worth the rail
    // (rule 16). It dedupes against the todo minted off the original assignment
    // message via the shared thread source, so re-triage merges, not duplicates.
    expectTodo: true,
    prior: { action_needed: 20, done: 6, fyi: 2 },
    recentMessages: [
      { direction: "received", snippet: "dvd: @Brain create a task from above in backlog" },
      {
        direction: "received",
        snippet:
          "dvd assigned you a comment: There is still some bug here, the fix in the morning for the imports did not trigger the deal driver messages, I had manually triggered through repl, please make sure this is fixed as well",
      },
    ],
  },
  {
    // Same trailing line, but NO earlier ask in the thread — a task was simply
    // filed. Awareness only. Must NOT be `done` (work just opened), and without
    // an assignment in-thread it lands `fyi`, never action_needed.
    name: "GUARD — bot 'Done. Created task' with no in-thread ask → fyi, never done",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Backlog",
    body: "Brain: Done. Created [Investigate slow dashboard load] in the 26.3 Backlog list.\nView comment or reply to add a comment",
    expectCategory: ["fyi"],
    expectTodo: false,
    expectCollabActivity: "other_activity",
    prior: { action_needed: 20, done: 6, fyi: 2 },
  },
  {
    // #351: a PURE status-change event (backlog → "10 web"), no assignment to the
    // user. The imperative task TITLE + an action_needed-heavy service prior used
    // to leak this to action_needed past rule 12e (self-reinforcing loop). The
    // service-prior over-classification challenge (detectConflict Net B) re-asks
    // with 12e spelled out and it should settle on fyi. Second pass expected —
    // model id will carry +2pass.
    name: "STATUS-CHANGE — 'set status to' with no assignment → fyi (rule 12e, #351)",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Functionality to change default behaviour of deal driver messages",
    body: "dvd set the status to 10 web\nView task or reply to add a comment",
    expectCategory: ["fyi"],
    expectTodo: false,
    expectCollabActivity: "state_change",
    prior: { action_needed: 20, done: 6, fyi: 2 },
  },
];

const EMPTY_OUTPUT_ATTEMPTS = 3;
const liveModel = getCheapModel();

const runLivePass: RunPass = async ({ system, prompt }) => {
  const result = await generateText({
    model: liveModel,
    system,
    prompt,
    output: Output.object({ schema: triageClassificationSchema }),
    temperature: 0,
    maxOutputTokens: 400,
    timeout: { totalMs: 30_000 },
  });
  const object = result.output;
  if (!Object.hasOwn(object, "collabActivity")) {
    throw new Error("[triage-smoke] cheap classifier omitted required collabActivity field");
  }
  return {
    ...object,
    confidence: clamp01(object.confidence),
    collabActivity: object.collabActivity ?? null,
  };
};

function isEmptyOutput(err: unknown): boolean {
  return /AI_NoOutputGeneratedError|AI_NoObjectGeneratedError|No output generated|No object generated/i.test(
    toMessage(err),
  );
}

async function classifyWithRetry(
  args: Parameters<typeof classifyEmail>[0],
): Promise<Awaited<ReturnType<typeof classifyEmail>>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= EMPTY_OUTPUT_ATTEMPTS; attempt++) {
    try {
      return await classifyEmail(args);
    } catch (err) {
      lastErr = err;
      if (!isEmptyOutput(err) || attempt === EMPTY_OUTPUT_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  let failures = 0;
  for (const c of CASES) {
    const { context: senderContext } = extractSenderContext({
      fromHeader: c.from,
      subject: c.subject,
      body: c.body,
    });
    let result: Awaited<ReturnType<typeof classifyEmail>>;
    try {
      result = await classifyWithRetry({
        identity: { name: "Yash", email: "yash.k@oliv.ai" },
        document: {
          id: "smoke",
          title: c.subject,
          content: `From: ${c.from}\nTo: yash.k@oliv.ai\nSubject: ${c.subject}\n\n${c.body}`,
          authoredAt: new Date("2026-06-11T09:51:48Z"),
          metadata: {
            from: c.from,
            to: "yash.k@oliv.ai",
            labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
          },
        },
        senderContext,
        runPass: runLivePass,
        observations: baseObs({
          senderPrior: {
            key: "notifications@tasks.clickup.com",
            categoryCounts: c.prior ?? {},
            lastCategory: "action_needed",
          },
          thread: {
            lastUserReplyAt: null,
            newestDirection: "received",
            messageCount: c.recentMessages?.length ?? 0,
            recentMessages: (c.recentMessages ?? []).map((m) => ({ ...m, authoredAt: null })),
          },
        }),
      });
    } catch (err) {
      failures++;
      console.log(`\n❌ ${c.name}`);
      console.log(`   classify error: ${toMessage(err)}`);
      continue;
    }
    const { classification, model } = result;
    const gotTodo = classification.todoDecision?.outcome === "proposed";
    const catOk = c.expectCategory.includes(classification.category);
    const todoOk = gotTodo === c.expectTodo;
    const collabOk =
      c.expectCollabActivity === undefined ||
      collabActivityPartition(classification.collabActivity) ===
        collabActivityPartition(c.expectCollabActivity);
    const ok = catOk && todoOk && collabOk;
    if (!ok) failures++;
    console.log(`\n${ok ? "✅" : "❌"} ${c.name}`);
    console.log(
      `   category: ${classification.category} (want ${c.expectCategory.join("|")}) ${catOk ? "ok" : "WRONG"} · model=${model}`,
    );
    console.log(
      `   todo: ${gotTodo ? `proposed "${classification.todoSuggestion?.name}"` : `none (${classification.todoDecision?.outcome})`} (want ${c.expectTodo ? "todo" : "none"}) ${todoOk ? "ok" : "WRONG"}`,
    );
    if (c.expectCollabActivity !== undefined) {
      console.log(
        `   collabActivity: ${classification.collabActivity ?? "null"} (${collabActivityPartition(classification.collabActivity)}) ` +
          `(want ${c.expectCollabActivity ?? "null"} / ${collabActivityPartition(c.expectCollabActivity)}) ${collabOk ? "ok" : "WRONG"}`,
      );
    }
    console.log(`   rationale: ${classification.rationale}`);
  }
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
