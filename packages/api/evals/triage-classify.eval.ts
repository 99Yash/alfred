import path from "node:path";
import { type AccountPersona, type SenderContext, type TriageCategory } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import {
  classifyEmail,
  resolveTodoSuggestion,
  todoSuppressionReason,
  type ClassifyEmailArgs,
  type TodoDecisionOutcome,
} from "../src/modules/triage/classify";
import { assembleObservations } from "../src/modules/triage/observations";
import type { ThreadMessageContext } from "../src/modules/triage/thread-state";
import { llmJudgeScorer } from "./lib/llm-judge";

/**
 * Behavioral eval for the email-triage classifier (ADR-0051 / ADR-0055).
 *
 * Runs the REAL `classifyEmail` sequence (cheap-model first pass → conditional
 * second pass → override floor) against the cheap model, then evaluates both the
 * category AND the rail-todo mint decision — the two outputs we keep hand-tuning
 * the rubric for. Three scorers, two deterministic + one LLM judge:
 *   1. Category match            — exact, deterministic.
 *   2. Todo mint decision        — did a rail todo mint? deterministic, mirrors
 *                                  production (resolveTodoSuggestion + the
 *                                  structural suppression guard).
 *   3. Classification defensible — LLM judge grading rationale soundness (the
 *                                  subjective dimension a deterministic check
 *                                  can't see). See ./lib/llm-judge.ts.
 *
 * The dataset is the DEV tier (small, hardest cases) per the eval-tier model:
 * golden positives + the documented real misses the prompt's own exemplars were
 * written against (the Sakshi-ownership bug, the ClickUp bot-"Done" burying a
 * live assignment, the LinkedIn senior-IC nicety, pre-merge PR advisory, the
 * freemium upsell). When the Loop-2 corrections table (`rejected_inferences`,
 * ADR-0056) is wired, its `cause='user'` rows become the regression tier — see
 * ./README.md.
 *
 * Run locally with GOOGLE_GENERATIVE_AI_API_KEY (classifier) + ANTHROPIC_API_KEY
 * (judge) in env: `pnpm --filter @alfred/api eval`.
 */

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

// Pin "now" so relative-date resolution in the todo path is stable: Wed 10 June 2026.
// classifyEmail manages its own per-call model timeout internally.
const NOW = new Date("2026-06-10T12:00:00Z");

const USER = { name: "Yash", email: "yash@example.com" };

interface Expected {
  category: TriageCategory;
  /** Whether a rail todo should mint. */
  todo: "mint" | "suppress";
  /** Human note on the decision — context for the judge and the reader. */
  note: string;
}

interface Case {
  label: string;
  from: string;
  subject: string;
  body: string;
  snippet?: string;
  labelIds?: string[];
  persona?: AccountPersona;
  knownContact?: boolean;
  /** Prior-key + histogram for senders that should carry a prior (services/bulk). */
  senderKey?: string | null;
  senderPrior?: Record<string, number>;
  lastCategory?: string;
  /** Prior thread messages (newest first) — drives follow_up/done/ownership reads. */
  recentMessages?: ThreadMessageContext[];
  messageCount?: number;
  newestDirection?: "sent" | "received";
  sender: SenderContext;
  authoredAt?: Date;
  expected: Expected;
}

const CASES: Case[] = [
  {
    label: "github-secret-exposed",
    from: "GitHub <noreply@github.com>",
    subject: "[acme/api] Redis URI exposed on GitHub",
    body: "A secret (Redis connection URI) was found exposed in a commit to acme/api. Rotate the credential immediately and remove it from history.",
    senderKey: "noreply@github.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "urgent",
      todo: "mint",
      note: "Exposed live secret — urgent (override floor), and a real rotate-now obligation.",
    },
  },
  {
    label: "self-initiated-login-code",
    from: "Anthropic <noreply@anthropic.com>",
    subject: "Your login code is 123456",
    body: "Enter this one-time code to finish signing in. It expires in 10 minutes. If you didn't request this, ignore the email.",
    senderKey: "noreply@anthropic.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "Self-initiated auth (rule 15) — fyi, nothing to remember (16c would_not_forget).",
    },
  },
  {
    label: "sakshi-standup-ownership",
    from: "Dave <dave@acme.com>",
    subject: "Standup coverage today",
    body: "Heads up — Sakshi is running standup today while I'm out. Nothing needed from you, just so you know who's driving.",
    persona: "work",
    knownContact: true,
    sender: { fromKind: "person", effectiveAuthor: "person" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "The action is owned by Sakshi, not the user (16a-ii) — fyi, no todo.",
    },
  },
  {
    label: "clickup-bot-done-buries-live-ask",
    from: "ClickUp <notifications@clickup.com>",
    subject: "Fix imports not triggering deal driver messages",
    body: "Brain: Done. Created [Fix imports not triggering deal driver messages] in the 26.3 Backlog list.",
    snippet: "Brain: Done. Created the task in the backlog.",
    senderKey: "notifications@clickup.com",
    senderPrior: { fyi: 6, done: 2 },
    lastCategory: "fyi",
    messageCount: 2,
    newestDirection: "received",
    recentMessages: [
      {
        direction: "received",
        authoredAt: new Date("2026-06-10T09:00:00Z"),
        snippet:
          "dvd assigned you a comment: there is still a bug here — imports aren't triggering the deal driver messages. please make sure this is fixed.",
      },
    ],
    sender: {
      fromKind: "service",
      effectiveAuthor: "bot",
      bodyActor: { kind: "bot", name: "Brain" },
    },
    expected: {
      category: "action_needed",
      todo: "mint",
      note: "Filing a backlog task OPENS work; the thread shows a live bug assigned to the user (rules 12e/17). The bot 'Done' is the filing, not the fix.",
    },
  },
  {
    label: "pr-review-pre-merge-advisory",
    from: "GitHub <notifications@github.com>",
    subject: "coderabbitai commented on pull request #42",
    body: "Review comment on /pull/42: consider adding an index on user_id to speed up this query. Nit: rename `foo` to `bar` for clarity. Overall looks good.",
    senderKey: "notifications@github.com",
    sender: {
      fromKind: "service",
      effectiveAuthor: "bot",
      botSlug: "coderabbit",
      bodyActor: { kind: "bot", name: "coderabbitai" },
    },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "Bot review on unmerged PR code — advisory by default (12a) and pre-merge, nothing live at stake (16b liveness); structural suppression also fires.",
    },
  },
  {
    label: "greptile-freemium-upsell",
    from: "Greptile <noreply@greptile.com>",
    subject: "You've reached your 50-review trial limit",
    body: "99Yash has reached the 50-review trial limit. Upgrade your plan to continue getting automated reviews from Greptile.",
    senderKey: "noreply@greptile.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "marketing",
      todo: "suppress",
      note: "Freemium upsell, nothing owed (11a) — marketing; manufactured conversion stake (16b not_significant).",
    },
  },
  {
    label: "linkedin-senior-ic-connect",
    from: "LinkedIn <invitations@linkedin.com>",
    subject: "Ankur Singh wants to connect",
    body: "Ankur Singh, Senior Software Developer at Sosuv, would like to connect with you on LinkedIn. Accept or ignore.",
    senderKey: "invitations@linkedin.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "action_needed",
      todo: "suppress",
      note: "Optional nicety; 'Senior <IC role>' is not senior leadership, and the urgency is the sender's (16a-i no_obligation) — no todo.",
    },
  },
  {
    label: "stripe-payment-failed",
    from: "Stripe <billing@stripe.com>",
    subject: "Your payment failed — update your card",
    body: "We couldn't charge your card for the $49.00 monthly invoice. Update your payment method by Jun 15 to avoid losing access to your account.",
    senderKey: "billing@stripe.com",
    sender: { fromKind: "service", effectiveAuthor: "service", botSlug: "stripe-billing" },
    expected: {
      category: "payment",
      todo: "mint",
      note: "Money owed on an existing paid relationship, access at risk (rule 11) — payment, real obligation with a date.",
    },
  },
  {
    label: "client-shipped-order-trailing-sow",
    from: "Priya <priya@client.com>",
    subject: "Order shipped — and one more thing",
    body: "Good news, your order has shipped (tracking #1Z999AA). Separately — please send the signed SOW by Friday so we can kick the project off on time.",
    persona: "work",
    knownContact: true,
    sender: { fromKind: "person", effectiveAuthor: "person" },
    authoredAt: NOW,
    expected: {
      category: "done",
      todo: "mint",
      note: "Closure email (done) carrying a real trailing ask the user owns — category and todo disagree (16a-c all pass).",
    },
  },
  {
    label: "subscribed-weekly-newsletter",
    from: "Substack Digest <digest@substack.com>",
    subject: "Your weekly digest: 5 stories you might like",
    body: "Here are this week's top stories from the writers you follow. Read on the web or in the app. Unsubscribe anytime from your settings.",
    senderKey: "digest@substack.com",
    senderPrior: { newsletter: 12 },
    lastCategory: "newsletter",
    labelIds: ["INBOX", "CATEGORY_UPDATES"],
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "newsletter",
      todo: "suppress",
      note: "Subscribed editorial digest — newsletter, no obligation.",
    },
  },
];

interface TaskOutput {
  category: TriageCategory;
  confidence: number;
  rationale: string;
  todoOutcome: TodoDecisionOutcome | undefined;
  todoName: string | null;
  wouldMintTodo: boolean;
  suppression: string | null;
  email: { from: string; subject: string; body: string };
}

function buildArgs(c: Case): ClassifyEmailArgs {
  const authoredAt = c.authoredAt ?? NOW;
  const signalText = [c.subject, c.body, c.snippet ?? ""].join("\n");
  const observations = assembleObservations({
    senderKey: c.senderKey ?? null,
    senderPrior: c.senderPrior
      ? { categoryCounts: c.senderPrior, lastCategory: c.lastCategory ?? null }
      : null,
    persona: c.persona ?? "work",
    thread: {
      lastUserReplyAt: null,
      newestDirection: c.newestDirection ?? null,
      messageCount: c.messageCount ?? 0,
      recentMessages: c.recentMessages ?? [],
    },
    knownContact: c.knownContact ?? false,
    labelIds: c.labelIds ?? ["INBOX"],
    signalText,
  });
  return {
    userId: undefined,
    identity: USER,
    document: {
      id: `eval_${c.label}`,
      title: c.subject,
      content: c.body,
      authoredAt,
      metadata: { from: c.from, snippet: c.snippet ?? c.body.slice(0, 160) },
    },
    senderContext: c.sender,
    observations,
  };
}

const RATIONALE_RUBRIC = `You are grading the REASONING of an email-triage classifier, not just its label.
- A: The chosen category is well-justified AND the rationale cites concrete, accurate cues from the actual email (sender, subject phrasing, body content, a decisive signal). The reasoning would convince a skeptical reviewer.
- B: The category is defensible but the rationale is generic, restates a rule without citing the email, or misses the decisive cue.
- C: The rationale contains a minor factual error about the email, OR the category is a borderline/arguable miss with otherwise-sound reasoning.
- D: The category is clearly indefensible for this email, OR the rationale fabricates a cue that isn't in the email.`;

evalite<Case, TaskOutput, Expected>("Triage classifier", {
  data: () => CASES.map((c) => ({ input: c, expected: c.expected })),
  task: async (input) => {
    void serverEnv().GOOGLE_GENERATIVE_AI_API_KEY;
    const args = buildArgs(input);
    const { classification } = await classifyEmail(args);
    const authoredAt = input.authoredAt ?? NOW;
    const resolved = resolveTodoSuggestion(classification, authoredAt);
    const suppression = todoSuppressionReason({
      sender: input.from,
      subject: input.subject,
      signalText: `${input.subject}\n${input.body}\n${input.snippet ?? ""}`,
    });
    const wouldMintTodo = resolved !== null && suppression === null;
    return {
      category: classification.category,
      confidence: classification.confidence,
      rationale: classification.rationale,
      todoOutcome: classification.todoDecision?.outcome,
      todoName: resolved?.name ?? null,
      wouldMintTodo,
      suppression,
      email: { from: input.from, subject: input.subject, body: input.body },
    };
  },
  scorers: [
    {
      // The hard signal: did the classifier land the right category?
      name: "Category match",
      scorer: ({ output, expected }) => ({
        score: expected && output.category === expected.category ? 1 : 0,
        metadata: expected
          ? `got ${output.category} (conf ${output.confidence.toFixed(2)}), want ${expected.category}`
          : "no expectation",
      }),
    },
    {
      // Mirrors production: would this email actually put a todo on the rail?
      // Evaluated through resolveTodoSuggestion + the structural suppression
      // guard, the same path the email-triage tail step runs.
      name: "Todo mint decision",
      scorer: ({ output, expected }) => {
        if (!expected) return { score: 0, metadata: "no expectation" };
        const want = expected.todo === "mint";
        const ok = output.wouldMintTodo === want;
        const got = output.wouldMintTodo
          ? `mint "${output.todoName}"`
          : `suppress (${output.suppression ?? output.todoOutcome ?? "no todo"})`;
        return {
          score: ok ? 1 : 0,
          metadata: `${got}; want ${expected.todo}`,
        };
      },
    },
    // The subjective dimension a deterministic check can't see: is the
    // classifier's stated reasoning actually sound and grounded in the email?
    llmJudgeScorer<Case, TaskOutput, Expected>({
      name: "Classification defensible",
      rubric: RATIONALE_RUBRIC,
      prompt: ({ output, expected }) =>
        [
          "Email under triage:",
          `From: ${output.email.from}`,
          `Subject: ${output.email.subject}`,
          `Body: ${output.email.body}`,
          "",
          "The classifier's output:",
          `- category: ${output.category}`,
          `- rationale: ${output.rationale}`,
          "",
          expected
            ? `For reference, the expected category is "${expected.category}" because: ${expected.note}`
            : "",
          "",
          "Grade the classifier's category + rationale against the rubric.",
        ].join("\n"),
    }),
  ],
  trialCount: 1,
});
