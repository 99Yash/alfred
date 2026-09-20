import path from "node:path";
import {
  collabActivityPartition,
  type AccountPersona,
  type CollabActivityKind,
  type SenderContext,
  type TriageCategory,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { config as loadEnv } from "dotenv";
import { evalite } from "evalite";
import {
  classifyEmail,
  resolveTodoSuggestion,
  todoSuppressionReason,
  type ClassifyEmailArgs,
  type RunPass,
  type TodoDecisionOutcome,
} from "@alfred/assistant/triage/classify";
import { extractSenderContext } from "@alfred/assistant/triage/sender-context";
import { DEFAULT_USER_TIMEZONE } from "@alfred/assistant/time";
import { assembleObservations, type Observations } from "@alfred/assistant/triage/observations";
import type { ThreadMessageContext } from "@alfred/assistant/triage/thread-state";
import { llmJudgeScorer } from "./lib/llm-judge";

/**
 * Behavioral eval for the email-triage classifier (ADR-0051 / ADR-0055).
 *
 * Runs the REAL `classifyEmail` sequence (cheap-model first pass → conditional
 * second pass → override floor) against the cheap model, then evaluates both the
 * category AND the rail-todo mint decision — the two outputs we keep hand-tuning
 * the rubric for. Four scorers, three deterministic + one LLM judge:
 *   1. Category match            — deterministic. Set membership, not equality:
 *                                  `Expected.category` is always a LIST of the
 *                                  categories that score 1, and `Expected.guards`
 *                                  additionally pins WHICH branch decided
 *                                  (`+spamfloor`, `+2pass`) for a case whose
 *                                  subject is a deterministic guard.
 *   2. Todo mint decision        — did a rail todo mint? deterministic, mirrors
 *                                  production (resolveTodoSuggestion + the
 *                                  structural suppression guard).
 *   3. CollabActivity match      — deterministic, and only for a case that
 *                                  asserts `collabActivity`: compares the
 *                                  PARTITION, not the literal kind.
 *   4. Classification defensible — LLM judge grading rationale soundness (the
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
 * Run locally with GOOGLE_GENERATIVE_AI_API_KEY in env: `pnpm --filter
 * @alfred/assistant eval`. That one key covers the whole suite — the classifier
 * under test and the judge both run on `route("cheap")` (Gemini Flash-Lite).
 */

loadEnv({ path: path.resolve(import.meta.dirname, "../../../apps/server/.env") });

// Pin "now" so relative-date resolution in the todo path is stable: Wed 10 June 2026.
// classifyEmail manages its own per-call model timeout internally.
const NOW = new Date("2026-06-10T12:00:00Z");

const USER = { name: "Yash", email: "yash@example.com" };

interface Expected {
  /**
   * The SET of categories that score 1 — ALWAYS a list, never a bare label, even
   * when the set has one member. The list-only shape is the enforcement: under a
   * `TriageCategory | list` union the compiler still accepts
   * `output.category === expected.category`, a template interpolation and a
   * spread, so the union would have caught none of this file's readers. A list
   * makes that equality a hard `TS2367` and leaves membership as the only thing
   * that compiles. Cases whose correct answer genuinely is a set — a spam-filed
   * promo is right as any passive tag and wrong only in a demand lane — then pin
   * the set instead of a coin flip between `marketing` and `fyi`.
   */
  category: readonly [TriageCategory, ...TriageCategory[]];
  /**
   * WHOLE tags from `classifyEmail`'s assembled `model` tag string that MUST be
   * present. The scorer splits that string on `+` and compares whole tags, so a
   * prefix never matches its longer sibling: `+2pass` does NOT match a row that
   * only ran `+2pass_failed`. Write one full tag per entry, leading `+` included.
   *
   * Six tags exist. Two come from this module's own passes, in
   * `classify.ts:1162-1165`: `+2pass` (the re-ask completed) and `+2pass_failed`
   * (the re-ask THREW — `classify.ts` sets this tag only in the `catch` arm, so
   * there is no second answer at all; the first pass is kept instead). Four come from the floor
   * fold, one per floor, in `floors/index.ts:140,155,160,172`: `+floor`
   * (override escalate), `+kindfloor`, `+spamfloor` and `+meetingfloor` (each a
   * demote). A floor that keeps the classification contributes no tag.
   *
   * This is what makes a case pin a DETERMINISTIC guard rather than the prompt:
   * a category that the first pass already gets right scores 1 whether the floor
   * fires or is deleted, because the accept set holds both answers. Naming the
   * tag here reddens the row when the branch that was supposed to decide never
   * ran. Omit it when the case is only pinning the rubric.
   */
  guards?: readonly string[];
  /** Whether a rail todo should mint. */
  todo: "mint" | "suppress";
  /** Expected model-emitted collaboration activity kind when the case exercises rule 19. */
  collabActivity?: CollabActivityKind | null;
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
  /**
   * Typed rule-16b cold-contact flag (what `resolveSenderRelationship` derives in
   * prod) — set alongside the prose so the deterministic cold-sender todo gate is
   * exercised through the production mint path. Defaults to `false`.
   */
  isColdContact?: boolean;
  /** Prior-key + histogram for senders that should carry a prior (services/bulk). */
  senderKey?: string | null;
  senderPrior?: Record<string, number>;
  lastCategory?: TriageCategory;
  /** Prior thread messages (newest first) — drives follow_up/done/ownership reads. */
  recentMessages?: ThreadMessageContext[];
  messageCount?: number;
  newestDirection?: "sent" | "received";
  /** When the user last replied on the thread — drives rule 18 (own reply closes the loop). */
  lastUserReplyAt?: Date | null;
  /** Active user-model projection signal; set when an eval must exercise sender-kind floors. */
  senderKind?: Observations["senderKind"];
  /**
   * Hand-set `SenderContext`, for a case whose sender shape is scene-setting
   * rather than the thing under test. OMIT it to DERIVE the context from `from`,
   * `subject` and `body` through the production `extractSenderContext` — which is
   * what a case must do when the envelope parse IS the fix it pins. A hard-coded
   * `{ fromKind: "service" }` on such a case asserts its own precondition and
   * stays green after the parse that produces it is reverted.
   */
  sender?: SenderContext;
  /**
   * Inject both cheap-model passes instead of calling the model. Only for a case
   * whose subject is a DETERMINISTIC guard downstream of the model: a floor that
   * only fires on a demand lane cannot be reached from a prompt the model is
   * meant to answer passively, so the canned pass hands the floor the input it
   * exists for. A case that leaves this unset runs the real classifier, which is
   * still what every rubric case does.
   */
  runPass?: RunPass;
  authoredAt?: Date;
  expected: Expected;
}

/**
 * The `SenderContext` a case classifies under: its own when it sets one, else the
 * production parse of its `From:` header. See `Case.sender`.
 */
function senderContextFor(c: Case): SenderContext {
  return (
    c.sender ??
    extractSenderContext({ fromHeader: c.from, subject: c.subject, body: c.body }).context
  );
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
      category: ["urgent"],
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
      category: ["fyi"],
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
      category: ["fyi"],
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
      category: ["action_needed"],
      todo: "mint",
      note: "Filing a backlog task OPENS work; the thread shows a live bug assigned to the user (rules 12e/17). The bot 'Done' is the filing, not the fix.",
    },
  },
  {
    label: "clickup-bot-created-task-without-ask",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Backlog",
    body: "Brain: Done. Created [Investigate slow dashboard load] in the 26.3 Backlog list.\nView comment or reply to add a comment",
    senderKey: "notifications@tasks.clickup.com",
    senderPrior: { action_needed: 20, done: 6, fyi: 2 },
    lastCategory: "action_needed",
    senderKind: {
      kind: "service",
      confidence: 0.92,
      evidenceCodes: ["email:local:service_strong"],
      entityId: "ent_clickup",
      displayName: "Oliv AI",
    },
    sender: {
      fromKind: "service",
      effectiveAuthor: "bot",
      bodyActor: { kind: "bot", name: "Brain" },
    },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      collabActivity: "other_activity",
      note: "The bot completed filing a new task, but no thread message assigns it to the user. Filing opens work, so this is passive activity (fyi), never done.",
    },
  },
  {
    label: "clickup-passive-status-change-imperative-title",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Fix deal driver messages after imports",
    body: "dvd set the status to 10 web\nView task or reply to add a comment",
    senderKey: "notifications@tasks.clickup.com",
    senderPrior: { action_needed: 20, done: 6, fyi: 2 },
    lastCategory: "action_needed",
    senderKind: {
      kind: "service",
      confidence: 0.92,
      evidenceCodes: ["email:local:service_strong"],
      entityId: "ent_clickup",
      displayName: "Oliv AI",
    },
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      collabActivity: "state_change",
      note: "The imperative subject names the tracked item. The body only records a passive status change, with no action assigned to the user.",
    },
  },
  {
    label: "clickup-passive-third-party-comment-collab-activity",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Conservice: Show all CRM fields as options",
    body: "Akash Ojha commented\nyes good catch\nView comment or reply to add a comment",
    senderKey: "notifications@tasks.clickup.com",
    senderPrior: { action_needed: 20, done: 6, fyi: 2 },
    lastCategory: "action_needed",
    senderKind: {
      kind: "service",
      confidence: 0.92,
      evidenceCodes: ["email:local:service_strong"],
      entityId: "ent_clickup",
      displayName: "Oliv AI",
    },
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      collabActivity: "other_activity",
      note: "Rule 19: passive third-party ClickUp comment is not directed at the user. The service sender-kind floor should demote any action_needed spike to fyi.",
    },
  },
  {
    label: "clickup-assigned-to-user-collab-activity",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Fix login redirect loop on SSO",
    body: "Akshay Jyothis assigned this task to you.\nDue Jun 14. Priority: High.\nThe SSO login redirects in a loop for enterprise accounts.",
    senderKey: "notifications@tasks.clickup.com",
    senderPrior: { action_needed: 20, done: 6, fyi: 2 },
    lastCategory: "action_needed",
    senderKind: {
      kind: "service",
      confidence: 0.92,
      evidenceCodes: ["email:local:service_strong"],
      entityId: "ent_clickup",
      displayName: "Oliv AI",
    },
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["action_needed"],
      todo: "mint",
      collabActivity: "assigned_to_user",
      note: "Rule 19 counter-case: assignment to the user is ownership activity, so the sender-kind floor must not demote it.",
    },
  },
  {
    label: "clickup-direct-mention-ask-collab-activity",
    from: "Oliv AI <notifications@tasks.clickup.com>",
    subject: "Deal Merge Flow",
    body: "Sanyam mentioned you in a comment\n@yash.k pls merge this PR before the release branch is cut: https://github.com/OlivAIRepo/autosched-mirror/pull/654",
    senderKey: "notifications@tasks.clickup.com",
    senderPrior: { action_needed: 20, done: 6, fyi: 2 },
    lastCategory: "action_needed",
    senderKind: {
      kind: "service",
      confidence: 0.92,
      evidenceCodes: ["email:local:service_strong"],
      entityId: "ent_clickup",
      displayName: "Oliv AI",
    },
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["action_needed"],
      todo: "mint",
      collabActivity: "mentioned_user",
      note: "Rule 19 counter-case: an @mention with a concrete merge ask is directed at the user and must stay demanding.",
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
      category: ["fyi"],
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
      category: ["marketing"],
      todo: "suppress",
      note: "Freemium upsell, nothing owed (11a) — marketing; manufactured conversion stake (16b not_significant).",
    },
  },
  {
    // Pins the `linkedin.com` entry of `KNOWN_SERVICE_DOMAINS` ALONE. `invitations`
    // is not a strong or weak service local and matches neither the prefix nor the
    // `…-noreply` suffix rule, so the domain entry is the only door to `service`
    // here: drop the entry and this envelope parses `unknown`. NO hand-set
    // `sender` — the parse is the thing under test. See `linkedin-invite-reminder-
    // relay` (the prod miss, either door) and `circle-relay-noreply-suffix` (the
    // suffix rule alone).
    //
    // That is a claim about the PARSE, not a promise that this row reddens. The
    // only scorer here reads `output.category`, and the system prompt already
    // names this envelope in an exemplar (`classify.ts:338`,
    // `invitations@linkedin.com → fyi`) that never reads `SenderContext`. So a
    // dropped domain entry most probably still scores 1 here. Of the two rows,
    // only `circle-relay-noreply-suffix` has a MEASURED revert proxy: its
    // envelope flips to `person`, which disarms rule 8a.
    label: "linkedin-senior-ic-connect",
    from: "LinkedIn <invitations@linkedin.com>",
    subject: "Ankur Singh wants to connect",
    body: "Ankur Singh, Senior Software Developer at Sosuv, would like to connect with you on LinkedIn. Accept or ignore.",
    senderKey: "invitations@linkedin.com",
    expected: {
      category: ["fyi"],
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
      category: ["fyi"],
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
      category: ["fyi"],
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
      category: ["awaiting_reply"],
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
      category: ["payment"],
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
      category: ["done"],
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
    isColdContact: true,
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
      category: ["done"],
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
      category: ["newsletter"],
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
    isColdContact: true,
    expected: {
      category: ["awaiting_reply"],
      todo: "suppress",
      note: "Cold sender, no correspondence history — not a real person waiting (16b cold_sender). The direct ask keeps awaiting_reply honest, but no todo. THIS is failure A.",
    },
  },
  {
    // The HyperNexus prod leak (thread 19f639e4c5bb290c, 2026-07-15): an
    // AI-generated cold sales follow-up from a personal-gmail "sales team" with
    // no prior contact. flash-lite tagged awaiting_reply and PROPOSED a todo
    // while writing note `cold_sender:` — the self-contradiction the backstop +
    // deterministic cold-sender floor now catch.
    label: "cold-outreach-sales-followup",
    from: "HyperNexus Sales Team <pelloni.robert@gmail.com>",
    subject: "Re: TormentNexus for 99Yash -- Thoughts?",
    body: "Just wanted to follow up on my previous note about TormentNexus. I'll keep this brief: it provides progressive MCP tool routing, dual-tier memory, and a resilient LLM waterfall with zero downtime. If you're even remotely curious about improving your agent coordination, I'd love to share a quick demo. Worth a conversation?",
    persona: "personal",
    sender: { fromKind: "person", effectiveAuthor: "person" },
    senderRelationship: "no prior contact on record",
    isColdContact: true,
    authoredAt: NOW,
    expected: {
      category: ["awaiting_reply"],
      todo: "suppress",
      note: "Cold sales follow-up from a personal-gmail 'sales team', no prior contact — the person-waiting stake is uncorroborated (16b cold_sender). 'Worth a conversation?' keeps awaiting_reply honest, but no rail todo. The HyperNexus prod leak.",
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
      category: ["action_needed"],
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
    isColdContact: true,
    expected: {
      category: ["payment"],
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
      category: ["fyi"],
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
    isColdContact: true,
    authoredAt: NOW,
    expected: {
      category: ["action_needed"],
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
      category: ["action_needed"],
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
      category: ["fyi"],
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
      category: ["urgent"],
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
      category: ["fyi"],
      todo: "suppress",
      note: "Self-initiated step-up / sudo code the user just triggered (rule 15) — mid-flow, expires harmlessly. fyi, nothing to remember (16c). The doc_tcfumx9884kk-class miss.",
    },
  },
  {
    label: "vendor-self-echo-passkey-created-fyi",
    from: "GitHub <noreply@github.com>",
    subject: "Passkey created",
    body: "A new passkey was just added to your account. You can now use it to sign in. If you did not create this passkey, review your security settings.",
    senderKey: "noreply@github.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      note: "Rule 15a vendor self-echo: GitHub reports an event on the GitHub account that the user could have performed, and asserts no observation of its own. The 'if you did not create this passkey' line is boilerplate that reads the same on a legitimate echo and on a phish, so it carries no signal.",
    },
  },
  {
    label: "vendor-self-echo-2fa-enabled-fyi",
    from: "GitHub <noreply@github.com>",
    subject: "Two-factor authentication enabled",
    body: "Two-factor authentication has been enabled for your account. If you did not make this change, review your security settings.",
    senderKey: "noreply@github.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      note: "Rule 15a vendor self-echo. The demotion does NOT turn on proving the user was mid-flow — it turns on the vendor asserting no observation about who acted.",
    },
  },
  {
    label: "unsolicited-new-device-signin-urgent",
    from: "Google <no-reply@accounts.google.com>",
    subject: "Suspicious sign-in from a new device — was this you?",
    body: "We detected a suspicious sign-in to your account from a new device in a location you don't usually sign in from. If this wasn't you, secure your account immediately.",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["urgent"],
      todo: "mint",
      note: "The UNSOLICITED inverse of rule 15 — a sign-in the user did NOT initiate. Stays urgent. The counter-case that keeps the self-initiated demotion from over-reaching.",
    },
  },
  {
    // Prod misses 1a0b21d242456b1b (urgent) and 1a0b21c6768a0e22 (action_needed):
    // both tagged off the vendor's "if you didn't do this" boilerplate alone. This
    // is the BOUNDARY exemplar for rule 15a — the loudest wording the rule must
    // still hold against — not the rule itself.
    label: "vendor-self-echo-password-changed-boilerplate-fyi",
    from: "Wellfound <team@wellfound.com>",
    subject: "Your Wellfound password was changed",
    body: "Your Wellfound password was changed. If you did not make this change, your account may be compromised — contact support immediately.",
    senderKey: "team@wellfound.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      note: "Rule 15a at its loudest: the vendor reports an event on its own account and asserts NO observation about who performed it. The compromise language is the vendor's boilerplate, which never escalates a category on its own. Contrast the unsolicited-new-device case, where the asserter names a device it observed.",
    },
  },
  {
    // Floor pin, not a prompt exemplar. `token` is still in the override floor's
    // noun set and `compromised` is still an exposure verb, so before #1165 this
    // body matched noun+verb inside the 100-char window and the floor forced
    // `urgent` at 0.85 — with the under-classification re-ask suppressed, because
    // `floorMatches` gates it. Deleting `password` from the noun set did not
    // reach this body. The fix blanks the rule-15a hedge before the predicate
    // runs. If the floor ever reads that hedge again, this row goes red.
    label: "vendor-self-echo-otp-token-boilerplate-fyi",
    from: "LinkedIn <security-noreply@linkedin.com>",
    subject: "Your verification code is 419283",
    body: "Your one-time token is 419283. This token expires in 10 minutes. Never share this token with anyone. If you did not request it, your account may be compromised.",
    senderKey: "security-noreply@linkedin.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      note: "Rule 15a. The vendor echoes a code the user asked for and asserts NO observation about who asked. The compromise line is the same boilerplate the Wellfound row carries; the only difference is the noun it sits next to.",
    },
  },
  {
    // Second floor pin, on the other shape the old predicate reached: a reset
    // LINK, where `token=` is a query parameter rather than a word. Same hedge,
    // same 100-char window, same forced `urgent` before #1165.
    label: "vendor-self-echo-reset-link-token-param-fyi",
    from: "Supabase <noreply@mail.app.supabase.io>",
    subject: "Reset your password",
    body: "Follow this link to reset your password: https://app.example.com/auth/v1/verify?token=pkce_9f1c4&type=recovery. If you did not request a password reset, your account may be compromised.",
    senderKey: "noreply@mail.app.supabase.io",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      note: "Rule 15a. The user asked for the reset; the vendor is echoing the link back. No asserter claims to have observed anything about who asked.",
    },
  },
  {
    label: "vendor-self-echo-oauth-app-added-fyi",
    from: "GitHub <noreply@github.com>",
    subject: "A third-party OAuth application was added to your account",
    body: "The OAuth application 'DeployBot' was authorized to access your account with repo and read:org scopes. If you did not authorize this, revoke its access.",
    senderKey: "noreply@github.com",
    sender: { fromKind: "service", effectiveAuthor: "service" },
    expected: {
      category: ["fyi"],
      todo: "suppress",
      note: "Rule 15a. The email cannot tell an authorization from a compromise, and that is exactly why it is zero signal: an urgent tag inside the mailbox it warns about is not a security control (rule 15c). No todo: verifying is a mechanical check, not a memorable obligation.",
    },
  },
  {
    // Prod miss #1097: tagged `awaiting_reply` off the reminder copy alone.
    // `senderKind` stays null ON PURPOSE — an unscored projection keeps the
    // sender-kind floor silent, so nothing but rule 8a and the third conflict
    // net stands between this envelope and the miss.
    label: "linkedin-invite-reminder-relay",
    from: "Vaibhav Sharma (via LinkedIn) <messages-noreply@linkedin.com>",
    subject: "Reminder: Vaibhav Sharma invited you to connect",
    body: "Vaibhav Sharma: Hi Yash, I'm still waiting for your response. Accept my invitation to connect on LinkedIn.",
    // NO hand-set `sender`: the LinkedIn half of #1097 lives entirely in
    // `extractSenderContext`, so writing `{ fromKind: "service" }` here would
    // assert the precondition the fix produces and stay green after the fix is
    // reverted. Derived instead. This EXACT envelope carries BOTH new rules — the
    // `…-noreply` suffix and the `linkedin.com` domain — and `classifyFromKind`
    // tests the suffix first, so this row proves their OR and neither one alone.
    // That is on purpose: it is the prod envelope, kept verbatim. The two rows
    // that separate the rules are `linkedin-senior-ic-connect` (domain alone) and
    // `circle-relay-noreply-suffix` (suffix alone).
    expected: {
      category: ["fyi"],
      todo: "suppress",
      note: "A platform relay, not a person: the `…-noreply@linkedin.com` envelope parses as a service, so rule 8a governs and the reminder copy is invitation boilerplate. Passive social activity → fyi, never awaiting_reply; no todo (16a-i no_obligation).",
    },
  },
  {
    // Pins the `…-noreply` SUFFIX rule alone: a platform relay on a domain that is
    // NOT in `KNOWN_SERVICE_DOMAINS`, so `SERVICE_LOCAL_SUFFIX_RE` is the only door to
    // `service`. Rename the local to `community-digest@` and the same header
    // parses `person` — measured against the production function. Generalizes the
    // #1097 fix past LinkedIn: every relay platform sends reminder copy in the
    // first person from an envelope it owns. NO hand-set `sender`.
    label: "circle-relay-noreply-suffix",
    from: "Rhea Kapoor (via Circle) <community-noreply@circle-community-mail.com>",
    subject: "Reminder: Rhea Kapoor is waiting for your reply in Build Club",
    body: "Rhea Kapoor: I'm still waiting for your response to my post in Build Club. Reply in the community to continue the thread.",
    expected: {
      category: ["fyi"],
      todo: "suppress",
      note: "The envelope is the platform's, not Rhea's, so rule 8a governs: passive social activity → fyi, never awaiting_reply off the relayed reminder copy. No todo (16a-i no_obligation).",
    },
  },
  {
    // Prod miss #1097: tagged `awaiting_reply` off "Would love your thoughts!".
    // Person-shaped ON PURPOSE — no service envelope and no sender prior help
    // here, so the case proves the Gmail SPAM label alone carries the outcome.
    label: "spam-filed-cold-promo",
    from: "Arjun Mehta <arjun@growthloop-outreach.com>",
    subject: "A quick idea for your onboarding funnel",
    body: "Hi Yash — I put together a short teardown of your onboarding funnel and found three drop-off points you could close in a week. Would love your thoughts!",
    labelIds: ["SPAM"],
    sender: { fromKind: "person", effectiveAuthor: "person" },
    expected: {
      category: ["marketing", "fyi", "newsletter"],
      todo: "suppress",
      note: "Gmail filed this as spam — a third party's verdict that the mail is unsolicited (rule 20). Judge the gist, not the phrasing: an unsolicited pitch is right as any passive tag and wrong in a reply lane, which the spam floor demotes to fyi if the model emits one.",
    },
  },
  {
    // The spam floor's DEMOTE branch, which `spam-filed-cold-promo` cannot reach:
    // that case's accept set holds both `marketing` (the first pass's own answer,
    // floor silent) and `fyi` (the floor's answer), so its row scores 1 whether
    // `applySpamDemotionFloor` fires or is deleted. Nothing else in the repo runs
    // the demote branch. So this case CANS both passes into `awaiting_reply` and
    // asserts the tag: `+spamfloor` disappears and the category reverts to
    // `awaiting_reply` the moment the floor stops demoting.
    //
    // A REPLY lane, not the `urgent` this case used to inject, because #1098
    // narrowed the floor to `awaiting_reply`/`follow_up`. The shape is the
    // measured prod true positive: a spam-filed event pitch whose "thoughts?"
    // copy the cheap model reads as an owed reply.
    label: "spam-filed-reply-lane-demotes",
    from: "Mira Sethi <mira@agentbuild-summit.com>",
    subject: "Re: AgentBuild Summit <> Yash!",
    body: "Hey Yash — following up on the summit. Would love your thoughts on the blog post we published last week. Registration closes soon, grab a spot here.",
    labelIds: ["SPAM"],
    sender: { fromKind: "person", effectiveAuthor: "person" },
    runPass: () =>
      Promise.resolve({
        category: "awaiting_reply",
        confidence: 0.8,
        rationale: "The sender asks for the user's thoughts on a post and is waiting on a reply.",
        todoSuggestion: { name: "Reply with thoughts on the blog post", assist: null },
        todoDecision: { outcome: "proposed", note: "The sender is waiting on a response." },
        collabActivity: null,
      }),
    expected: {
      category: ["fyi"],
      guards: ["+spamfloor"],
      todo: "suppress",
      note: 'Gmail filed this as spam, so "would love your thoughts" is engagement copy, not an owed reply (rule 20). A reply lane claims the SENDER is owed something, which is exactly what the spam verdict denies, so the floor demotes it to fyi and clears the proposed todo — demote, never bury.',
    },
  },
  {
    // The other half of the narrowed floor (#1098): a spam-filed DEMAND lane is
    // now the final answer to keep. It injects both passes like the row above,
    // so the prompt is out of the path entirely and only the floor decides — the
    // category reverts to `fyi` and `+spamfloor` appears the moment the floor
    // goes back to gating all four demand lanes.
    //
    // Everything else about the pair DIFFERS, and the difference is the point:
    // that row injects `awaiting_reply` behind a person envelope (the lane the
    // floor still gates), this one injects `urgent` behind a service envelope
    // (the lane it released). One canned shape either side of the new gate line.
    //
    // `+spamfloor` is asserted by ABSENCE, through the category: `Expected.guards`
    // has no negative form, and it needs none here. A fired floor lands on `fyi`,
    // which is not in this accept set.
    //
    // Deliberately the PHISH body, not a genuine ask, because that is the cost
    // #1098 accepted: Gmail's verdict is fallible, so a spam-filed `urgent` now
    // reaches the rail on the model's word. DEMOTE, NEVER BURY cuts the other way
    // here — a false `urgent` is dismissible, a buried rotation ask is not.
    label: "spam-filed-phish-keeps-model-answer",
    from: "Billing Support <secure-billing@acme-invoices-verify.com>",
    subject: "URGENT: your account will be suspended in 24 hours",
    body: "We could not process your last payment. Verify your billing details within 24 hours or your account and all data will be permanently suspended.",
    labelIds: ["SPAM"],
    sender: { fromKind: "service", effectiveAuthor: "service" },
    runPass: () =>
      Promise.resolve({
        category: "urgent",
        confidence: 0.9,
        rationale:
          "The body threatens permanent account suspension within 24 hours unless billing details are verified now.",
        todoSuggestion: { name: "Verify billing details", assist: null },
        todoDecision: { outcome: "proposed", note: "Stated 24-hour deadline on account access." },
        collabActivity: null,
      }),
    expected: {
      category: ["urgent"],
      todo: "mint",
      note: "The spam floor no longer gates `urgent`/`action_needed` (#1098): Gmail's spam verdict is a fallible third party's, so on the demand lanes it is a prompt-side prior and the model owns the call. This row cans the model away, so it pins the floor's silence alone — and the surviving todo is the accepted cost, since the floor no longer clears one here.",
    },
  },
  {
    // Acceptance criterion 2, and the only row in the file that can prove rule
    // 20's EXCEPTION: a spam-filed mail carrying an obligation the USER already
    // owns keeps its demand lane. The shape is the prod miss of 2026-09-16 — a
    // recruiter asking the user to finish a job application the USER opened,
    // filed `SPAM` by Gmail, one of five spam-labelled documents in ten days.
    //
    // NO `runPass` and NO hand-set `sender`, on purpose. The rule-20 prose IS the
    // thing under test, so the real classifier must answer it, and the envelope
    // must derive `person` through the production parse. Revert the rule-20
    // exception and this row reddens: the old text said a spam-filed mail is
    // NEVER a demand lane, and the model obeyed it.
    //
    // READ THIS ROW'S WARRANT NARROWLY. The subject, the sender and the domain
    // match nothing in the system prompt, which is why the row is a support
    // ticket rather than the prod recruiter mail it is modelled on. But the
    // OBLIGATION does match: the worked example at classify.ts:338 — added by
    // this same PR — names "a case or ticket the user opened themselves", and
    // this row is ticket HD-4471. So the row instantiates the arm the example
    // names. It proves COMPLIANCE inside rule 20's rubric, not generalization
    // past it; a row that generalizes needs an obligation shape the example
    // does not name. Keep that distinction when this row is cited as proof —
    // a strengthened prompt masking the rule beneath it is the third instance
    // of this class in the campaign, see
    // .lessons/a-strengthened-prompt-masks-the-deterministic-branch-under-it.md.
    //
    // The discriminator against `spam-filed-phish-keeps-model-answer` above is
    // whether the demand survives WITHOUT trusting the sender. This ticket is
    // the user's own; the phish deadline exists only in the sender's claim. The
    // ask is an upload rather than a written answer, so rule 3's reply-shape
    // preference does not pull it into the lane the floor still gates.
    label: "spam-filed-owned-ticket-keeps-demand-lane",
    from: "Deepa Raman <deepa.raman@northbeam-support.com>",
    subject: "Ticket HD-4471 needs your diagnostics upload before Friday",
    body: "Hi Yash — your ticket HD-4471 is open with our engineering team. They cannot reproduce the fault until you upload the diagnostics bundle to the support portal and set the firmware version on the ticket. The ticket auto-closes on Friday if the upload is still missing.",
    labelIds: ["SPAM"],
    expected: {
      category: ["action_needed", "urgent"],
      todo: "mint",
      note: "Gmail filed this as spam and Gmail is wrong: the user opened ticket HD-4471 themselves, so the upload is an obligation the user ALREADY owns and it does not depend on trusting the sender (rule 20's exception). A hard spam bound would bury a real ask — demote, never bury, cuts the other way on the demand lanes.",
    },
  },
  {
    // Pins conflict net C (over-classification C) ALONE, the way
    // `spam-filed-reply-lane-demotes` pins the spam floor. Every other relay row
    // reaches `fyi` on the FIRST pass, because rule 8a already answers a relayed
    // invitation — so deleting net C leaves all of them green and the net
    // unpinned. A canned first pass removes the prompt from the path entirely.
    //
    // The row satisfies every net-C gate deterministically: `awaiting_reply`,
    // no exposed-secret match (`floorMatches` is `matchesExposedSecret` only),
    // not Gmail IMPORTANT, `senderKind` null (no `senderKey`, so the projection
    // never scored this sender), `effectiveAuthor: "service"` DERIVED from the
    // `…-noreply` suffix, and no ownership `collabActivity`. Delete the net and
    // the first pass persists: the category reverts to `awaiting_reply` and
    // `+2pass` disappears. A double red, measured, with no classifier tokens.
    //
    // On the Circle envelope, not a LinkedIn one, because `classify.ts:338`
    // names the LinkedIn reminder verbatim — a LinkedIn row would prove the
    // exemplar as much as the net.
    label: "circle-relay-net-c-reask",
    from: "Rhea Kapoor (via Circle) <community-noreply@circle-community-mail.com>",
    subject: "Rhea Kapoor is still waiting for your reply in Build Club",
    body: "Rhea Kapoor: I'm still waiting for your response. Reply in the community to continue the thread.",
    runPass: ({ pass }) =>
      Promise.resolve(
        pass === "first"
          ? {
              category: "awaiting_reply",
              confidence: 0.8,
              rationale:
                "The sender says they are still waiting for a response, so a reply is owed.",
              todoSuggestion: null,
              todoDecision: { outcome: "no_obligation", note: "No concrete deliverable." },
              collabActivity: null,
            }
          : {
              category: "fyi",
              confidence: 0.9,
              rationale:
                "The envelope belongs to the platform, so rule 8a governs: relayed community activity is passive, and the waiting phrase is engagement boilerplate.",
              todoSuggestion: null,
              todoDecision: { outcome: "no_obligation", note: "No user-owned obligation." },
              collabActivity: null,
            },
      ),
    expected: {
      category: ["fyi"],
      guards: ["+2pass"],
      todo: "suppress",
      note: "A deterministic service envelope cannot owe a reply, so net C re-asks once and the second pass returns the passive answer rule 8a requires. The `+2pass` tag proves the re-ask ran rather than threw.",
    },
  },
];

interface TaskOutput {
  category: TriageCategory;
  /**
   * `classifyEmail`'s assembled model-tag string: the base model id followed, in
   * sequence order, by `+2pass` / `+2pass_failed` and one tag per floor that
   * fired. It is the ONLY place a caller can read WHICH branch decided the
   * category — the classification itself looks identical whether the first pass
   * answered `fyi` or a floor demoted a demand lane into it. `Expected.guards`
   * asserts against this, and every row renders it.
   */
  model: string;
  confidence: number;
  rationale: string;
  collabActivity: CollabActivityKind | null;
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
 * `route`'s `withFallback` wraps — ai-retry only sees the raw provider
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
    senderRelationshipIsCold: c.isColdContact ?? false,
    senderKind: c.senderKind ?? null,
    labelIds: c.labelIds ?? ["INBOX"],
    signalText,
  });

  return {
    identity: USER,
    document: {
      id: `eval_${c.label}`,
      title: c.subject,
      content: c.body,
      authoredAt,
      metadata: { from: c.from, snippet: c.snippet ?? c.body.slice(0, 160) },
    },
    senderContext: senderContextFor(c),
    observations,
    // Spread rather than assigned: `exactOptionalPropertyTypes` is on, so a
    // literal `runPass: undefined` is not the same as an absent key.
    ...(c.runPass ? { runPass: c.runPass } : {}),
    // Fail fast to the configured fallback under provider overload instead of burning
    // three exponential-backoff cycles per case. Without this, a CI run during a
    // sustained-throttle window blows the eval job's wall-clock budget. Prod
    // leaves this unset (SDK default).
    maxRetries: 1,
    // No hedging in the eval (#436). Hedging buys tail latency on a live
    // mailbox; here it would only double the request volume against the same
    // flash-lite pool this suite is already throttled by — the exact pressure
    // `maxRetries: 1` above exists to relieve. Precision is unaffected either
    // way (both draws are `temperature: 0` over the same schema).
    hedgeDelayMs: 0,
  };
}

function renderJudgeContext(c: Case, sender: SenderContext): string {
  const lines: string[] = [
    // The RESOLVED context, not `c.sender` — a case that derives its sender from
    // the `From:` header has no `c.sender` to print, and the judge grades the
    // rationale against what the classifier actually saw.
    `SenderContext: ${JSON.stringify(sender)}`,
    `Known contact: ${c.knownContact ? "yes" : "no"}`,
  ];

  // The classifier reads the Gmail label set (SPAM/TRASH/IMPORTANT/CATEGORY_*),
  // so the judge must see it too — otherwise a rationale that cites Gmail's own
  // spam verdict looks like a fabricated cue and grades D.
  if (c.labelIds) {
    lines.push(`Gmail labels: ${c.labelIds.join(", ")}`);
  }

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
    const context = renderJudgeContext(input, args.senderContext);

    let classification;
    let model;

    try {
      ({ classification, model } = await classifyWithRetry(args));
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
        model: "(not classified)",
        confidence: 0,
        rationale: `[skipped: ${kind}]`,
        collabActivity: null,
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

    // Fixtures carry no user, so the anchor zone is fixed at UTC — the assist
    // dates the cases assert are relative to that.
    const resolved = resolveTodoSuggestion(classification, {
      sentAt: authoredAt,
      timezone: DEFAULT_USER_TIMEZONE,
    });

    const suppression = todoSuppressionReason({
      sender: input.from,
      subject: input.subject,
      signalText: `${input.subject}\n${input.body}\n${input.snippet ?? ""}`,
      category: classification.category,
      isColdContact: input.isColdContact ?? false,
    });

    const wouldMintTodo = resolved !== null && suppression === null;

    return {
      category: classification.category,
      model,
      confidence: classification.confidence,
      rationale: classification.rationale,
      collabActivity: classification.collabActivity ?? null,
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
      // The hard signal: did the classifier land the right category — AND, when
      // the case names one, did the guard that was supposed to decide it run?
      // The second half is not decoration: a case whose accept set holds both the
      // first pass's answer and a floor's answer scores 1 with the floor deleted,
      // which is how the spam floor came to have no net at all.
      name: "Category match",
      scorer: ({ output, expected }) => {
        if (output.skipped) return { score: 0, metadata: "skipped (provider overload)" };

        if (!expected) return { score: 0, metadata: "no expectation" };

        const categoryOk = expected.category.includes(output.category);

        // Whole-tag match, never a substring: `model` is one CONCATENATED tag list
        // (`<base>+2pass+spamfloor`), and one tag is a prefix of another —
        // `"+2pass_failed".includes("+2pass")` is true, so a substring test would
        // score a discarded re-ask as a completed one. Split on the separator the
        // assembler joins with and compare whole tags.
        const ranTags = new Set(
          output.model
            .split("+")
            .slice(1)
            .map((tag) => `+${tag}`),
        );

        const missingGuards = (expected.guards ?? []).filter((tag) => !ranTags.has(tag));

        const got =
          `got ${output.category} (conf ${output.confidence.toFixed(2)}) via ${output.model}, ` +
          `want ${expected.category.join("/")}`;

        return {
          score: categoryOk && missingGuards.length === 0 ? 1 : 0,
          metadata: missingGuards.length
            ? `${got}; guard never ran: ${missingGuards.join(", ")}`
            : got,
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
    {
      name: "CollabActivity match",
      scorer: ({ output, expected }) => {
        if (output.skipped) return { score: 0, metadata: "skipped (provider overload)" };

        if (!("collabActivity" in (expected ?? {}))) {
          return { score: 1, metadata: "not asserted" };
        }

        const gotPartition = collabActivityPartition(output.collabActivity);
        const wantPartition = collabActivityPartition(expected?.collabActivity);

        return {
          score: gotPartition === wantPartition ? 1 : 0,
          metadata:
            `got ${output.collabActivity ?? "null"} (${gotPartition}), ` +
            `want ${expected?.collabActivity ?? "null"} (${wantPartition})`,
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
          // The WHOLE accept set, not its first member: on the one path a
          // set-valued case exists to catch — the floor fires and the answer
          // moves to `fyi` — naming only the primary would score the row 1 on
          // `Category match` and have the judge grade the same row down.
          expected
            ? `For reference, the expected category is any of ${expected.category.map((c) => `"${c}"`).join(", ")} because: ${expected.note}`
            : "",
          "",
          "Grade the classifier's category + rationale against the rubric.",
        ].join("\n"),
    }),
  ],
  trialCount: 1,
});
