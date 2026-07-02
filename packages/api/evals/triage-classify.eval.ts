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
  /**
   * Rendered Sender relationship descriptor (ADR-0059) for a human sender —
   * set directly here so the rubric's person-waiting gate is exercised
   * deterministically without a populated graph. `undefined` → no line.
   */
  senderRelationship?: string | null;
  /** Prior-key + histogram for senders that should carry a prior (services/bulk). */
  senderKey?: string | null;
  senderPrior?: Record<string, number>;
  lastCategory?: string;
  /** Prior thread messages (newest first) — drives follow_up/done/ownership reads. */
  recentMessages?: ThreadMessageContext[];
  messageCount?: number;
  newestDirection?: "sent" | "received";
  /** When the user last replied on the thread — drives rule 18 (own reply closes the loop). */
  lastUserReplyAt?: Date | null;
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
      category: "fyi",
      todo: "suppress",
      note: "A social-network connection request is passive social activity → fyi (rule 8a), NOT awaiting_reply/action_needed — accepting or ignoring is the sender's want, not a question the user must answer (16a-i no_obligation); no todo.",
    },
  },
  {
    label: "linkedin-people-you-may-know",
    from: "LinkedIn <notifications@linkedin.com>",
    subject: "People you may know at Acme",
    body: "Grow your network: add Priya, Karan, and Maya to your LinkedIn network. View profiles or connect now.",
    senderKey: "notifications@linkedin.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "Network-growth nudges are passive social activity (rule 8a), not a task the user owns; no todo.",
    },
  },
  {
    label: "linkedin-profile-search-nudge",
    from: "LinkedIn <notifications@linkedin.com>",
    subject: "You appeared in 13 searches this week",
    body: "Your profile appeared in 13 searches this week. See who's searching for you and update your profile to get more views.",
    senderKey: "notifications@linkedin.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "Profile-activity notifications are passive awareness / manufactured engagement (rule 8a); no todo.",
    },
  },
  {
    label: "linkedin-real-person-message",
    from: "LinkedIn <messages-noreply@linkedin.com>",
    subject: "Priya sent you a message",
    body: "Priya: Can you confirm whether the API migration is safe to ship this week?",
    persona: "work",
    knownContact: true,
    sender: {
      fromKind: "service",
      effectiveAuthor: "person",
      bodyActor: { kind: "person", name: "Priya" },
    },
    senderRelationship: 'strong · two-way thread · same-org · you: "Founder, Acme"',
    expected: {
      category: "awaiting_reply",
      todo: "mint",
      note: "Rule 8a exception: a real correspondent's platform message with a genuine ask is judged on content; strong relationship means a real person is waiting.",
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
    // Rule 18 — the user's own reply closes the loop. The re-eval re-keys on the
    // inbound ask (the document under triage), but thread state shows the user
    // already replied (latest message is the user's send). The user owes nothing
    // further → done, NOT awaiting_reply. This is the #360 / #282-follow-up case,
    // mirrored from the live prod ShortLoop thread (2026-06-30).
    label: "recruiter-ask-user-already-replied",
    from: '"Sanjay (Shortloop)" <sanjay@shortloop.dev>',
    subject: "Re: Founding Engineer Role @ ShortLoop",
    body: "Hi Yash — would you be open to a quick chat this week about the founding engineer role at ShortLoop? Happy to work around your schedule.",
    persona: "personal",
    sender: { fromKind: "person", effectiveAuthor: "person" },
    senderRelationship: "no prior contact on record",
    messageCount: 2,
    newestDirection: "sent",
    lastUserReplyAt: new Date("2026-06-10T11:30:00Z"),
    recentMessages: [
      {
        direction: "sent",
        authoredAt: new Date("2026-06-10T11:30:00Z"),
        snippet:
          "Thanks for reaching out — yes, I'd be happy to chat. I'm free Thursday afternoon, does 3pm work?",
      },
      {
        direction: "received",
        authoredAt: new Date("2026-06-10T09:00:00Z"),
        snippet:
          "Would you be open to a quick chat this week about the founding engineer role at ShortLoop?",
      },
    ],
    authoredAt: new Date("2026-06-10T09:00:00Z"),
    expected: {
      category: "done",
      todo: "suppress",
      note: "The user has ALREADY replied — the latest thread message is the user's send and thread state shows the reply. The user owes nothing further, so the thread is no longer awaiting_reply → done (rule 18; the user's side of the loop is closed, waiting on the recruiter is not a user action). No todo: already handled (16e) and a cold sender besides.",
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

  // ── ADR-0059 directional significance — the Sender relationship gate.
  // Cases 1/2/6 prove relationship disambiguates the person-waiting stake;
  // cases 3/5 are the over-correction guardrail (intrinsic stakes survive a
  // cold sender); case 4 proves the 16a title carve-out is deleted.
  {
    label: "cold-recommendation-seeker",
    from: "Rahul Mehta <rahul@unknownstartup.io>",
    subject: "Quick favor — a recommendation?",
    body: "Hi, we haven't really met, but I'm applying for a new role and would love a LinkedIn recommendation from you. Could you write a few lines about my work? Would mean a lot.",
    persona: "work",
    sender: { fromKind: "person", effectiveAuthor: "person" },
    senderRelationship: "no prior contact on record",
    expected: {
      category: "awaiting_reply",
      todo: "suppress",
      note: "Cold sender, no correspondence history — not a real person waiting (16b cold_sender). The direct ask keeps awaiting_reply honest, but no todo. THIS is failure A.",
    },
  },
  {
    label: "strong-twoway-colleague-ask",
    from: "Priya <priya@acme.com>",
    subject: "Need your changes on the Q3 budget",
    body: "Can you review the Q3 budget sheet and send me your edits? Finance review is blocked on your numbers.",
    persona: "work",
    knownContact: true,
    sender: { fromKind: "person", effectiveAuthor: "person" },
    senderRelationship: 'strong · two-way thread · same-org · you: "Founder, Acme"',
    expected: {
      category: "action_needed",
      todo: "mint",
      note: "Strong two-way same-org colleague with a direct, blocking ask — a real person is waiting (16b passes). Same ask shape as the cold seeker, opposite todo call.",
    },
  },
  {
    label: "cold-sender-invoice-overdue",
    from: "Maya Designs <maya@mayadesigns.co>",
    subject: "Invoice #44 — $4,000 now overdue",
    body: "Following up on invoice #44 for the design work delivered in May. The $4,000 balance is now 15 days overdue — please remit payment this week.",
    persona: "work",
    sender: { fromKind: "person", effectiveAuthor: "person" },
    senderRelationship: "no prior contact on record",
    expected: {
      category: "payment",
      todo: "mint",
      note: "Cold sender, but money owed is an INTRINSIC stake — NOT gated by the person-waiting rule. Over-correction guard: the relationship gate must not kill real bills.",
    },
  },
  {
    label: "cold-founder-linkedin-connect",
    from: "LinkedIn <invitations@linkedin.com>",
    subject: "Arjun Rao wants to connect",
    body: "Arjun Rao, Founder & CEO at NimbusAI, would like to connect with you on LinkedIn. Accept or ignore.",
    senderKey: "invitations@linkedin.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "A connection request is passive social activity → fyi (rule 8a), even from a 'Founder & CEO' — the seniority of the requester does not make it a question the user must answer. Todo also suppressed (16a-i optional nicety). Reverses the prior action_needed expectation: an optional nicety with no obligation is passive awareness, not an action.",
    },
  },
  {
    label: "weak-oneway-hard-deadline",
    from: "Program Chair <chair@confxyz.org>",
    subject: "Camera-ready due Jun 18",
    body: "Your accepted paper's camera-ready version is due Jun 18. Submit via the portal by then or it will be withdrawn from the proceedings.",
    persona: "work",
    sender: { fromKind: "person", effectiveAuthor: "person" },
    senderRelationship: "weak · one-way inbound (you never replied)",
    authoredAt: NOW,
    expected: {
      category: "action_needed",
      todo: "mint",
      note: "Weak/one-way sender, but a hard deadline + loss of publication is an INTRINSIC stake — ungated. Over-correction guard alongside the invoice case.",
    },
  },
  {
    label: "moderate-sameorg-blocking-ask",
    from: "Karan <karan@acme.com>",
    subject: "Staging migration plan?",
    body: "Can you put together the staging migration plan and send it over by EOD? I'm blocked on it for my PR.",
    persona: "work",
    knownContact: true,
    sender: { fromKind: "person", effectiveAuthor: "person" },
    senderRelationship: "moderate · two-way thread · same-org",
    authoredAt: NOW,
    expected: {
      category: "action_needed",
      todo: "mint",
      note: "Moderate, two-way, same-org colleague with a concrete blocking ask — a real person waiting (16b passes).",
    },
  },
  // --- #263: vendor service-status incident vs the user's OWN infra alert ---
  {
    label: "vendor-status-incident-fyi",
    from: "Anthropic Status <no-reply@status.anthropic.com>",
    subject: "Claude Incident — elevated error rate on Opus 4.8",
    body: "We are investigating elevated error rates affecting the Claude API and Console. Some requests may fail or be delayed. We will post updates here as we have them.",
    persona: "work",
    senderKey: "no-reply@status.anthropic.com",
    senderPrior: { fyi: 2, done: 1 },
    lastCategory: "fyi",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "The VENDOR'S own outage — the user only consumes Claude, cannot act on the outage (rule 12f). fyi while ongoing (would be done on 'resolved'); NEVER urgent, however alarming 'elevated error rate' reads. The 06-24 doc_b608m5vh4cni miss.",
    },
  },
  {
    label: "own-sentry-production-outage-urgent",
    from: "Sentry <noreply@sentry.io>",
    subject: "[acme-api] Error rate spiking in production",
    body: "Your project acme-api is throwing 500s in production. Error rate is 40% over the last 10 minutes and climbing. Issue: TypeError in checkout handler, first seen 12 minutes ago.",
    persona: "work",
    senderKey: "service:sentry",
    sender: {
      fromKind: "service",
      effectiveAuthor: "bot",
      botSlug: "sentry",
      bodyActor: { kind: "bot", name: "Sentry" },
    },
    expected: {
      category: "urgent",
      todo: "mint",
      note: "The USER'S OWN project failing in production, same-day actionable (rule 12c) — stays urgent. The ownership counter-case to the vendor-status rule: don't sweep the user's own infra into fyi.",
    },
  },
  // --- #264: self-initiated codes/security confirmations vs unsolicited security alerts ---
  {
    label: "self-initiated-sudo-code-fyi",
    from: "GitHub <noreply@github.com>",
    subject: "[GitHub] Sudo email verification code",
    body: "Here is your sudo verification code: 284613. Enter it to confirm your identity and continue. This code expires in 15 minutes. If you did not request it, you can ignore this email.",
    senderKey: "noreply@github.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "Self-initiated step-up / sudo code the user just triggered (rule 15) — mid-flow, expires harmlessly. fyi, nothing to remember (16c). The doc_tcfumx9884kk-class miss.",
    },
  },
  {
    label: "self-initiated-passkey-created-fyi",
    from: "GitHub <noreply@github.com>",
    subject: "Passkey created",
    body: "A new passkey was just added to your account. You can now use it to sign in. If you did not create this passkey, review your security settings.",
    senderKey: "noreply@github.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "Expected echo of a user-initiated security setup action (rule 15) — already completed by the time it surfaces. fyi, no todo.",
    },
  },
  {
    label: "self-initiated-2fa-enabled-fyi",
    from: "GitHub <noreply@github.com>",
    subject: "Two-factor authentication enabled",
    body: "Two-factor authentication has been enabled for your account. If you did not make this change, review your security settings.",
    senderKey: "noreply@github.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "fyi",
      todo: "suppress",
      note: "Security-setup confirmation class from #264 — expected echo, not a new task. fyi, no todo.",
    },
  },
  {
    label: "unsolicited-new-device-signin-urgent",
    from: "Google <no-reply@accounts.google.com>",
    subject: "Suspicious sign-in from a new device — was this you?",
    body: "We detected a suspicious sign-in to your account from a new device in a location you don't usually sign in from. If this wasn't you, secure your account immediately.",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "urgent",
      todo: "mint",
      note: "The UNSOLICITED inverse of rule 15 — a sign-in the user did NOT initiate. Stays urgent. The counter-case that keeps the self-initiated demotion from over-reaching.",
    },
  },
  {
    label: "oauth-app-added-boundary-action-needed",
    from: "GitHub <noreply@github.com>",
    subject: "A third-party OAuth application was added to your account",
    body: "The OAuth application 'DeployBot' was authorized to access your account with repo and read:org scopes. If you did not authorize this, revoke its access.",
    senderKey: "noreply@github.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: "action_needed",
      todo: "suppress",
      note: "Rule 15 BOUNDARY: not a code — could be unsolicited compromise and the email can't tell. Keep surfaced at action_needed (not urgent absent a same-day breach, not fyi). No todo: verifying is a mechanical check, not a memorable obligation.",
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
  context: string;
  email: { from: string; subject: string; body: string };
  /**
   * True when the cheap model AND its configured fallback were both overloaded and
   * the case couldn't be classified — see `isTransientOverload`. Such a case
   * scores 0 (evalite has no per-case exclude), but with the fallback in
   * place this is rare; a run with many skips is a provider outage, not a
   * classifier regression, and the skip warnings in the log say so.
   */
  skipped: boolean;
}

/**
 * Recognize a transient provider-capacity error (Gemini/Anthropic "high
 * demand"/overloaded, 429, 503). These are NOT classifier defects — when both
 * the cheap model and its fallback are saturated, retrying for minutes only
 * blows the CI job's wall-clock budget, so the eval skips the case instead.
 */
function isTransientOverload(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /high demand|overloaded|rate.?limit|too many requests|\b429\b|\b503\b|temporarily unavailable|AI_RetryError/i.test(
    msg,
  );
}

/**
 * An empty-output failure from `generateObject`: the provider returns a 200 with
 * no parseable object, so the AI SDK throws `AI_NoOutputGeneratedError` /
 * `AI_NoObjectGeneratedError`. These fire ABOVE the model layer that
 * `getCheapModel`'s `withFallback` wraps — ai-retry only sees the raw provider
 * call *succeed*, so the flash-lite→flash fallback never engages. They are
 * transient (a fresh attempt almost always parses), and a Gemini blip would
 * otherwise skip a chunk of the suite and redden the gate with no code defect —
 * so the task retries before giving up. See `classifyWithRetry`.
 */
function isEmptyOutput(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /AI_NoOutputGeneratedError|AI_NoObjectGeneratedError|No output generated|No object generated/i.test(
    msg,
  );
}

/**
 * Classify with a bounded retry on empty-output failures. `withFallback` can't
 * catch these (wrong layer — see `isEmptyOutput`), so the recovery lives here.
 * A genuine provider outage still surfaces: after every attempt empty-outputs
 * we rethrow and the case skips (scores 0), so "many skips" stays a real outage
 * signal rather than being silently masked.
 */
const EMPTY_OUTPUT_ATTEMPTS = 3;

async function classifyWithRetry(
  args: ClassifyEmailArgs,
): Promise<Awaited<ReturnType<typeof classifyEmail>>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= EMPTY_OUTPUT_ATTEMPTS; attempt++) {
    try {
      return await classifyEmail(args);
    } catch (err) {
      lastErr = err;
      if (!isEmptyOutput(err) || attempt === EMPTY_OUTPUT_ATTEMPTS) throw err;
      // Brief escalating backoff so the flash-lite pool can drain between tries.
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastErr;
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
      lastUserReplyAt: c.lastUserReplyAt ?? null,
      newestDirection: c.newestDirection ?? null,
      messageCount: c.messageCount ?? 0,
      recentMessages: c.recentMessages ?? [],
    },
    knownContact: c.knownContact ?? false,
    senderRelationship: c.senderRelationship ?? null,
    senderKind: null,
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
    // Fail fast to the configured fallback under provider overload instead of burning
    // three exponential-backoff cycles per case. Without this, a CI run during a
    // sustained-throttle window blows the eval job's wall-clock budget. Prod
    // leaves this unset (SDK default).
    maxRetries: 1,
  };
}

function renderJudgeContext(c: Case): string {
  const lines: string[] = [
    `SenderContext: ${JSON.stringify(c.sender)}`,
    `Known contact: ${c.knownContact ? "yes" : "no"}`,
  ];

  if (c.senderRelationship) {
    lines.push(`Sender relationship: ${c.senderRelationship}`);
  }

  if (c.senderKey) {
    const prior = c.senderPrior
      ? Object.entries(c.senderPrior)
          .map(([category, count]) => `${category}:${count}`)
          .join(", ")
      : "no history";
    lines.push(`Sender prior [${c.senderKey}]: ${prior}`);
  }

  if (c.messageCount || c.recentMessages?.length) {
    lines.push(
      `Thread: ${c.messageCount ?? 0} prior message(s); newest is ${c.newestDirection ?? "unknown"}`,
    );
    if (c.lastUserReplyAt) {
      lines.push(`You last replied on ${c.lastUserReplyAt.toISOString().slice(0, 10)}`);
    }
    for (const message of c.recentMessages ?? []) {
      const who = message.direction === "sent" ? "you sent" : "received";
      lines.push(`Recent thread message [${who}]: ${message.snippet}`);
    }
  }

  return lines.join("\n");
}

const RATIONALE_RUBRIC = `You are grading the REASONING of an email-triage classifier, not just its label.
- A: The chosen category is well-justified AND the rationale cites concrete, accurate cues from the actual email and supplied deterministic context (sender, subject phrasing, body content, thread/sender observations, a decisive signal). The reasoning would convince a skeptical reviewer.
- B: The category is defensible but the rationale is generic, restates a rule without citing the email/context, or misses the decisive cue.
- C: The rationale contains a minor factual error about the email, OR the category is a borderline/arguable miss with otherwise-sound reasoning.
- D: The category is clearly indefensible for this email, OR the rationale fabricates a cue that isn't in the email.`;

evalite<Case, TaskOutput, Expected>("Triage classifier", {
  data: () => CASES.map((c) => ({ input: c, expected: c.expected })),
  task: async (input) => {
    void serverEnv().GOOGLE_GENERATIVE_AI_API_KEY;
    const args = buildArgs(input);
    const email = { from: input.from, subject: input.subject, body: input.body };
    const context = renderJudgeContext(input);

    let classification;
    try {
      ({ classification } = await classifyWithRetry(args));
    } catch (err) {
      // The task must NEVER throw: a classifier-QUALITY regression shows up as a
      // wrong category (which still scores), whereas a THROW here is always an
      // infra/provider/SDK failure — a transient overload, or the AI SDK's
      // `Output.object` parse intermittently rejecting valid JSON. Letting it
      // propagate aborts the whole eval file AND trips an evalite-beta reporter
      // bug (`renderErrorsSummary` → "reading 'pool'") that hangs the process
      // until the CI job's wall-clock timeout. So skip the case (scores 0) and
      // log it loudly — many skips mean a provider/SDK outage, not a regression.
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const kind =
        isTransientOverload(err) || isEmptyOutput(err) ? "provider overload" : "classify error";
      console.warn(`[triage-eval] SKIP "${input.label}" — ${kind}: ${reason}`);
      return {
        category: "fyi",
        confidence: 0,
        rationale: `[skipped: ${kind}]`,
        todoOutcome: undefined,
        todoName: null,
        wouldMintTodo: false,
        suppression: null,
        context,
        email,
        skipped: true,
      };
    }

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
      context,
      email,
      skipped: false,
    };
  },
  scorers: [
    {
      // The hard signal: did the classifier land the right category?
      name: "Category match",
      scorer: ({ output, expected }) => {
        if (output.skipped) return { score: 0, metadata: "skipped (provider overload)" };
        return {
          score: expected && output.category === expected.category ? 1 : 0,
          metadata: expected
            ? `got ${output.category} (conf ${output.confidence.toFixed(2)}), want ${expected.category}`
            : "no expectation",
        };
      },
    },
    {
      // Mirrors production: would this email actually put a todo on the rail?
      // Evaluated through resolveTodoSuggestion + the structural suppression
      // guard, the same path the email-triage tail step runs.
      name: "Todo mint decision",
      scorer: ({ output, expected }) => {
        if (output.skipped) return { score: 0, metadata: "skipped (provider overload)" };
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
      // Don't spend a judge call grading a case we couldn't classify.
      skipWhen: ({ output }) => (output.skipped ? "skipped (provider overload)" : null),
      prompt: ({ output, expected }) =>
        [
          "Email under triage:",
          `From: ${output.email.from}`,
          `Subject: ${output.email.subject}`,
          `Body: ${output.email.body}`,
          "",
          "Supplied deterministic context visible to the classifier:",
          output.context,
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
