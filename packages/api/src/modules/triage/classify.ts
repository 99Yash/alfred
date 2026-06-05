import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
import { type SenderContext } from "@alfred/contracts";
import { TRIAGE_CATEGORIES, type TriageCategory } from "@alfred/integrations/google";
import { z } from "zod";
import type { Observations } from "./observations";

/**
 * Email triage classifier — context-rich, cheap-model-always (ADR-0051).
 *
 * Cheap-tier model (gemini-2.5-flash-lite) classifies a single email into one
 * of ten categories matching the user's numbered Gmail labels. Intelligence
 * comes not from a bigger model but from deterministic **observations** fed in
 * (sender prior histogram, account persona, thread state, known-contact flag,
 * Gmail-native signals, regex content flags — assembled by the workflow, see
 * `observations.ts`). Two deterministic nets wrap the model:
 *
 *  - a **conditional second cheap pass** ({@link detectConflict}) re-runs the
 *    model once with a hard conflict spelled out; the second output is final;
 *  - a small high-precision **override floor** ({@link applyOverrideFloor})
 *    forces `urgent` on the one unambiguous severity signal (exposed secret).
 *
 * `classifyEmail` owns the whole sequence and returns the final classification
 * plus an audit object for the `triage.sender_extraction` log. There is no boss
 * `deepen` escalation (ADR-0051 superseded ADR-0042's classifier shape).
 *
 * The four added buckets are narrow seams against existing ones — `urgent` vs
 * `action_needed`, `follow_up` vs `awaiting_reply`, `done` vs `fyi`, `marketing`
 * vs `newsletter` — each disambiguated by an explicit prompt rule.
 */

export const triageClassificationSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  /**
   * [0, 1] — surfaced in the UI for low-confidence soft-confirms. Below
   * 0.5 the workflow still applies the chosen label (we always pick one,
   * to avoid leaving the message untriaged), but flags it for the briefing
   * to optionally surface as "alfred wasn't sure."
   */
  confidence: z.number().min(0).max(1),
  /** Short rationale grounded in the email — used for audit and debugging. */
  rationale: z.string().min(1).max(500),
  /**
   * Optional real-time todo proposal for the rail (ADR-0050 amendment 2026-06-05).
   * Non-null ONLY when this email is an actionable, context-complete commitment
   * worth tracking — the email-triage tail step turns it into a `suggested`
   * todo via `system.suggest_todo`. Governed by rule 16: the category gate
   * (never marketing/newsletter/fyi/done) plus a context-sufficiency test, so a
   * vague ask ("something broke, fix it") stays `null` even when the category
   * is `action_needed`/`urgent`. The model must always emit the key (null when
   * no todo) — this is one field on the existing cheap call, not a second call.
   */
  todoSuggestion: z
    .object({
      /** Crisp imperative title for the rail checkbox row. */
      name: z.string().min(1).max(120),
      /** Optional one-liner on how to approach it, or an honest "can't act yet". */
      assist: z.string().max(280).optional(),
    })
    .nullable()
    // Optional on the TYPE so non-cheap-classifier producers (tests) need not
    // set it; the cheap call is prompted to always emit it (null when no todo),
    // and the triage tail step reads `?? null`.
    .optional(),
});
export type TriageClassification = z.infer<typeof triageClassificationSchema>;

/** A single cheap-model pass — the seam the second pass and tests drive. */
export type RunPass = (input: {
  system: string;
  prompt: string;
  pass: "first" | "second";
}) => Promise<TriageClassification>;

export interface ClassifyEmailArgs {
  /** Optional metering attribution. The classifier itself does not read user context. */
  userId?: string;
  document: {
    id: string;
    title: string | null;
    content: string;
    authoredAt: Date | null;
    /** Provider metadata — `from`, `to`, `cc`, `labelIds`, `snippet`. */
    metadata: Record<string, unknown>;
  };
  /**
   * Deterministic parse of the sender/envelope/body actor (ADR-0042 #1,
   * unchanged). The classifier uses this typed context but loads no broader
   * user profile or memory.
   */
  senderContext: SenderContext;
  /**
   * Deterministic pre-model observations (ADR-0051 §4a). Assembled by the
   * workflow (sender prior, persona, thread state, known-contact, Gmail
   * signals, content flags) and fed into the prompt as hints — never verdicts.
   */
  observations: Observations;
  /** Run/step ids forwarded to the metering log + Langfuse trace. */
  runId?: string;
  stepId?: string;
  /** Stable per-call idempotency key — caller derives from `(runId, stepId, doc.id, attempt)`. */
  idempotencyKey?: string;
  /**
   * Test/seam override for the cheap model call. Production leaves this unset
   * and the real metered `getCheapModel()` call is used; tests inject canned
   * pass outputs to exercise the conflict/second-pass/floor logic without a
   * live LLM (no model mocking framework in the repo).
   */
  runPass?: RunPass;
}

/** Why the conditional second cheap pass fired (ADR-0051 §4b, Phase 3 seed). */
export interface TriageConflict {
  kind: "under_classification" | "over_classification";
  /** Human-readable conflict spelled out into the second-pass prompt + audit. */
  message: string;
}

/** Audit trail of the full classify sequence, logged to `triage.sender_extraction`. */
export interface ClassifyAudit {
  firstPass: TriageClassification;
  conflict: TriageConflict | null;
  secondPass: TriageClassification | null;
  /** True when the override floor forced a category change (not merely matched). */
  floorForced: boolean;
}

const PASSIVE_CATEGORIES = new Set<TriageCategory>(["fyi", "done", "newsletter", "marketing"]);
const IMPORTANT_CATEGORIES = new Set<TriageCategory>(["urgent", "action_needed"]);
/**
 * Categories that NEVER carry a rail todo, even when the cheap model emits a
 * `todoSuggestion` anyway (rule 16a category gate). The deterministic floor
 * against a stray suggestion on passive mail. Mirrors PASSIVE_CATEGORIES today
 * but kept SEPARATE on purpose: the todo gate and the conflict-net passive set
 * are independent policies that happen to coincide, and either could move
 * without the other.
 */
const TODO_INELIGIBLE_CATEGORIES = new Set<TriageCategory>([
  "marketing",
  "newsletter",
  "fyi",
  "done",
]);
/** Categories that count toward a sender's "bulk" share for the over-classification net. */
const BULK_PRIOR_CATEGORIES = new Set<string>(["newsletter", "marketing", "fyi", "done"]);
const STRONG_BULK_MIN_TOTAL = 5;
const STRONG_BULK_MIN_SHARE = 0.8;

/**
 * Override-floor predicate (ADR-0051 §5, Phase 3 seed = ONE signal). Keys on
 * EXPOSURE VERBS, deliberately narrower than the broad `hasSecurityKeyword`
 * content flag — a self-initiated "sign in"/"your code is 123456" link contains
 * none of these verbs, so it never trips the floor (the bug that opened v3).
 * `[\s\S]` (dotall) so the noun and verb can wrap onto separate lines, as
 * security-bot bodies do.
 *
 * The noun set is narrower than `hasSecurityKeyword` ON PURPOSE: the generic
 * `credential` is excluded here (it stays in the broad hint regex) because
 * `credential` + `exposed` over an 80-char window matches ordinary engineering
 * prose ("the credential object is exposed to the network") and the floor is
 * unrecoverable — a false positive force-tags an architecture email `urgent`.
 */
const OVERRIDE_FLOOR_SECRET_RE =
  /\b(?:secret|api[ -]?key|token|private key|password)\b[\s\S]{0,80}\b(?:exposed|leaked|committed|compromised)\b/i;

const SYSTEM_PROMPT = `You triage emails for a personal assistant. Classify each email into EXACTLY ONE category:

- urgent: action needed within hours, not days. Unsolicited security alerts (unrecognized/suspicious sign-in "was this you?", password or 2FA changed without the user, account compromised), billing failure that breaks access today, deadline today, critical CI/CD blocking ship. NOT a routine login link or code the user requested themselves — that is action_needed (rule 15).
- action_needed: the user must take a concrete step that isn't time-critical. Reply, decide, complete a task, click a confirm link, click a sign-in/magic link, enter a one-time login code, rotate a credential, update a card before its actual deadline, verify identity, fix a broken build, respond to a code review.
- follow_up: a soft check-in or nudge on a prior thread — "any update on...?", "circling back", "just following up." The sender already knows the user is aware; they're probing for status.
- awaiting_reply: someone is asking the user a direct first question, and the only action is to write back. Pick this when no prior thread exists or the message is a fresh ask.
- meeting: a meeting the user is expected to attend, prepare for, schedule, reschedule, or answer availability for. Direct calendar invites, agenda/prep emails for the user's meeting, room/availability negotiations, and "your meeting starts soon" pings.
- fyi: passive awareness items. Resolved-incident status posts, product release notes without action, social activity digests, "we updated our terms" notices, GitHub notifications that don't require review, legal/investor/shareholder notices with no user action.
- done: explicit closure or completion notice. Order shipped, payment received, deploy succeeded, ticket resolved, "your request has been processed."
- payment: invoices, receipts that need attention, payment failures, billing notices, refunds, statements.
- newsletter: subscription content the user opted into — weekly digests, Substack posts, professional newsletters, automated content publication.
- marketing: promotional / sales blasts. "20% off this weekend", product launches, public brand events/webinars/keynotes, cold outbound sales, growth-team nurture sequences.

How to use the Observations block:
- The observations are DETERMINISTIC CONTEXT — hints to focus your attention, never verdicts. You still decide the category from the email itself.
- Sender prior is this sender's past category histogram. A 99%-newsletter sender can still send one genuinely urgent message — trust the message over the prior when they disagree. The prior breaks routine ties, it does not override a clear signal.
- Account persona (work/personal) frames what "urgent"/"action_needed" mean for this account.
- Thread state ("you last replied on <date>") is context for follow_up vs awaiting_reply vs done — not a deterministic mapping.
- Known contact = the sender is in the user's contacts. A direct ask from a known contact is more likely a real awaiting_reply/action_needed.
- Gmail signals (categories, IMPORTANT, STARRED) are Gmail's own priors — lean on them when they align.
- Content flags are cheap regex tells: unsubscribe → newsletter/marketing; currency → payment; security → look harder at severity; calendar → meeting; investorNotice → rule 9; publicEvent → rule 8. They are signals to weigh, not commands.

Rules:
1. Pick exactly one category — the dominant one if multiple apply.
2. Time-pressure: prefer 'urgent' over 'action_needed' when consequence-of-delay is hours-not-days (account compromise, security breach, billing failure that breaks access today). A login link or code merely expiring is NOT such a consequence — the user just requests a fresh one.
3. Reply-shape: prefer 'awaiting_reply' over 'action_needed' when the action IS the reply.
4. Reply-shape (continued): prefer 'follow_up' over 'awaiting_reply' when the sender is nudging on an existing thread, not opening a new ask. "Any update?" / "Just circling back" → follow_up.
5. Closure: prefer 'done' over 'fyi' when the message explicitly marks something as finished/shipped/resolved/succeeded. 'fyi' is for informational items that don't close a loop.
6. Promo split: prefer 'marketing' over 'newsletter' for unsolicited promotional blasts, sales pitches, cold outbound, public product launches, brand events, webinars, and keynotes. 'newsletter' is for subscribed editorial/digest content the user opted into.
7. Meeting gate: choose 'meeting' only when the user is a participant or likely participant in a personal/work calendar-style meeting. The words "meeting", "event", "conference", "webinar", "keynote", "AGM", or "annual general meeting" are NOT enough by themselves.
8. Bulk/public event rule: public events, brand announcements, product launches, webinars, conferences, keynotes, and "save the date" blasts are marketing/newsletter/fyi, not meeting, unless the email is a direct calendar invite or scheduling thread for the user. (The publicEvent content flag marks this language.)
9. Investor/legal notice rule: stock-market, shareholder, AGM, proxy/e-voting, annual report, exchange filing, and registrar/depository notices are usually 'fyi'. Use 'action_needed' only when the email asks the user to vote, register, submit a form, make a decision, or meet a concrete deadline. Do not use 'meeting' for a corporate AGM notice just because the notice says "meeting". (The investorNotice content flag marks this language.)
10. 'meeting' takes precedence over 'action_needed' / 'awaiting_reply' only after the Meeting gate is satisfied.
11. 'payment' takes precedence over 'fyi' / 'done' for any financial transaction notice.
12. Automated/service mail:
    12a. Bot review comments where SenderContext.effectiveAuthor='bot' and botSlug is coderabbit, copilot-review, github-actions, dependabot, or renovate are usually 'fyi'. They are advisory review noise by default, even when they contain suggested fixes or CVE identifiers.
    12b. Escalate a bot review comment to 'action_needed' or 'urgent' only when the body itself shows severe impact: exposed secret/token/key, auth bypass, data loss, production outage, blocked deploy, or a same-day security/account deadline.
    12c. Severity-suspect bot alerts where botSlug is sentry, stripe-billing, google-security, vercel, or datadog should be classified from body content alone: 'urgent' if same-day actionable, 'action_needed' if remediation is needed but not immediate, otherwise 'fyi'/'done'.
    12d. Unknown service envelopes classify from body content alone.
13. Confidence:
    - 0.9+: unambiguous (newsletter from a clearly subscribed sender, payment receipt with amount, secret-scanning alert from GitHub).
    - 0.7-0.9: clear category but with some overlap.
    - 0.5-0.7: educated guess; pick the best fit but flag uncertainty.
    - Below 0.5: only when no category fits well; still pick the closest one. Low scores get surfaced to the user as "alfred wasn't sure."
14. Rationale: 1-2 sentences citing concrete cues (sender, subject phrasing, body content, a decisive observation). Don't restate the rule.
15. Self-initiated authentication mail — sign-in / magic links, one-time login codes (OTP), and email-address verification the user just requested — is action_needed, not urgent. It carries no consequence-of-delay beyond having to request a fresh code. Reserve urgent for UNSOLICITED security alerts: an unrecognized sign-in, a "was this you?" challenge, or a password/2FA change the user did not make.
16. Todo suggestion (rail) — IN ADDITION to the category, decide whether this email is a commitment worth tracking on the user's todo rail. A todo earns its place ONLY if it is something the user could plausibly FORGET or DROP and would be glad to see tracked. Most actionable mail does not clear this bar. Set the \`todoSuggestion\` field, always present:
    16a. NEVER propose (todoSuggestion is null) for:
        - marketing, newsletter, fyi, or done categories — the category tag is NECESSARY but NOT sufficient;
        - self-initiated authentication mail (rule 15's class: sign-in / magic links, one-time login codes, email-address verification the user just requested). The user triggered it, already knows about it, and the link or code expires harmlessly — there is nothing to remember. A "log in" todo is pure noise;
        - anything the user is self-evidently already mid-flow on, or that resolves itself without the user tracking it.
    16b. Propose ONLY when BOTH hold: (i) it is worth acting on for the day, AND (ii) the email carries enough concrete context to write a specific, self-contained action.
    16c. If the ask is vague or you cannot say what to actually DO from the email alone — "something broke, please fix it" with no what/where, "let's catch up sometime", a problem report missing the specifics — set todoSuggestion to null EVEN WHEN the category is action_needed or urgent. A vague rail item is worse than none.
    16d. When you do propose: \`name\` is a crisp imperative naming the SUBJECT, so the user knows what it is at a glance without opening the email ("Reply to Priya about the Q3 budget", "Rotate the exposed Redis credential before EOD") — never a bare verb ("Log in", "Reply"). \`assist\` is OPTIONAL: include it only when it adds real guidance the \`name\` doesn't already carry — a decision to weigh, a concrete next step, or an honest "I can't act on this yet — <reason>" when there is no path. OMIT it rather than restate the obvious ("click the link in the email" adds nothing). Never invent specifics absent from the email.

Examples (subject → category):
- "[acme/repo] Redis URI exposed on GitHub" from noreply@github.com → urgent (credential must be rotated today).
- "Sign-in attempt from a NEW device — was this you?" from security@google.com → urgent (unsolicited compromise alert).
- "Sign in to Anthropic" / "Your login code is 123456" / "Verify your email address" the user just requested → action_needed (self-initiated auth, expires harmlessly — rule 15, NOT urgent), and todoSuggestion is null (rule 16a — the user already knows, nothing to track).
- "@alice requested your review on PR #42" from noreply@github.com → action_needed (review owed, not time-critical).
- "Any update on the proposal?" from a client → follow_up (nudge on existing thread).
- "Quick question about Q3 numbers" from a colleague → awaiting_reply (fresh ask, reply IS the action).
- "Your order has shipped — tracking #..." from amazon.com → done (closure notice).
- "Incident resolved: API latency" from status@vercel.com → done (explicit resolution).
- "We updated our Privacy Policy" from a service → fyi (informational, no closure).
- "Your payment failed — update your card" from billing@stripe.com → payment (rule 11) — bump to urgent if access breaks today.
- "**coderabbitai** commented on this pull request" with normal review suggestions → fyi (bot review, advisory by default).
- "**coderabbitai** commented: API key exposed in this PR" → urgent (secret/security exception).
- "Dependabot alert: CVE-2024-1234 in lodash (moderate)" → fyi (advisory bot, no exposed secret — rule 12a).
- "Errors spiking in production" from Sentry → urgent/action_needed depending on immediacy and the user's project context.
- "Weekly digest from Substack: 5 stories" → newsletter (subscribed content).
- "20% off everything this weekend only!" from a retailer → marketing (promotional blast).
- "See you next week." from Apple / Inside Apple with WWDC or product-event content → marketing (public brand event, not the user's meeting).
- "Join our launch webinar on Thursday" from a vendor → marketing (public event blast, not a personal meeting).
- "Sundram Fasteners Limited — 63rd Annual General Meeting..." from a registrar/depository → fyi (shareholder/legal notice, not the user's meeting).
- "Proxy voting closes tomorrow — cast your vote" from a registrar/depository → action_needed (concrete user action/deadline).
- "Design review moved to 3pm — can you attend?" from a colleague/client → meeting (user participation/scheduling).

Output JSON: { "category": "...", "confidence": 0.0-1.0, "rationale": "...", "todoSuggestion": { "name": "...", "assist": "..." } | null }`;

function renderObservations(obs: Observations): string {
  const lines: string[] = ["=== Observations (deterministic context — hints, not verdicts) ==="];
  lines.push(`Account persona: ${obs.persona ?? "unknown"}`);

  const counts = obs.senderPrior.categoryCounts;
  const keys = Object.keys(counts);
  if (obs.senderPrior.key && keys.length) {
    const hist = keys.map((k) => `${k}:${counts[k]}`).join(", ");
    lines.push(
      `Sender prior [${obs.senderPrior.key}]: { ${hist} } (last: ${obs.senderPrior.lastCategory ?? "n/a"})`,
    );
  } else if (obs.senderPrior.key) {
    lines.push(`Sender prior [${obs.senderPrior.key}]: no history yet`);
  } else {
    lines.push(`Sender prior: n/a (human sender — judge per message)`);
  }

  lines.push(`Known contact: ${obs.knownContact ? "yes" : "no"}`);

  const t = obs.thread;
  if (t.messageCount > 0) {
    const replied = t.lastUserReplyAt
      ? `you last replied ${t.lastUserReplyAt.toISOString()}`
      : "you have not replied";
    lines.push(
      `Thread: ${t.messageCount} prior message(s); ${replied}; newest is ${t.newestDirection ?? "unknown"}`,
    );
  } else {
    lines.push(`Thread: new (no prior messages on file)`);
  }

  const g = obs.gmail;
  lines.push(
    `Gmail signals: categories=[${g.categories.join(", ")}]; important=${g.important}; starred=${g.starred}; inbox=${g.inInbox}`,
  );

  const c = obs.content;
  lines.push(
    `Content flags: unsubscribe=${c.hasUnsubscribe}; currency=${c.hasCurrencyAmount}; security=${c.hasSecurityKeyword}; ` +
      `calendar=${c.hasCalendarInvite}; investorNotice=${c.hasInvestorNotice}; publicEvent=${c.hasPublicEventLanguage}`,
  );
  return lines.join("\n");
}

function userPrompt(args: ClassifyEmailArgs, conflict: TriageConflict | null): string {
  const lines: string[] = [];
  const meta = args.document.metadata;
  const from = typeof meta.from === "string" ? meta.from : null;
  const to = typeof meta.to === "string" ? meta.to : null;
  const cc = typeof meta.cc === "string" ? meta.cc : null;

  lines.push("=== SenderContext ===");
  lines.push(JSON.stringify(args.senderContext));
  lines.push("");

  lines.push(renderObservations(args.observations));
  lines.push("");

  if (from) lines.push(`From: ${from}`);
  if (to) lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (args.document.title) lines.push(`Subject: ${args.document.title}`);
  if (args.document.authoredAt) lines.push(`Date: ${args.document.authoredAt.toISOString()}`);
  lines.push("");

  lines.push("=== Body ===");
  // Cap to keep token budget bounded — most emails fit easily; the rare long
  // thread gets truncated, which is fine for triage (the lede usually suffices).
  const content =
    args.document.content.length > 6_000
      ? args.document.content.slice(0, 6_000) + "\n[…truncated]"
      : args.document.content;
  lines.push(content);

  if (conflict) {
    lines.push("");
    lines.push("=== INCONSISTENCY DETECTED (reconsider) ===");
    lines.push(conflict.message);
    lines.push(
      "A deterministic check flags your first answer as a likely error. Re-read the email and the observations: if your first classification was right, keep it and say why; otherwise correct it.",
    );
  }
  return lines.join("\n");
}

/**
 * Sum a sender prior histogram and the share that falls in bulk categories.
 * Used by the over-classification conflict net.
 */
function priorBulkProfile(categoryCounts: Record<string, number>): {
  total: number;
  bulkShare: number;
} {
  let total = 0;
  let bulk = 0;
  for (const [cat, n] of Object.entries(categoryCounts)) {
    total += n;
    if (BULK_PRIOR_CATEGORIES.has(cat)) bulk += n;
  }
  return { total, bulkShare: total > 0 ? bulk / total : 0 };
}

/**
 * Detect a hard deterministic conflict between the model's output and a strong
 * expectation (ADR-0051 §4b, Phase 3 seed — two tightly-gated nets). Returns the
 * conflict to spell into a single second cheap pass, or null. PURE.
 *
 * `floorMatches` is the override-floor predicate result — passed in so the
 * under-classification net doesn't fire a redundant second pass when the floor
 * will force `urgent` regardless.
 */
export function detectConflict(
  classification: TriageClassification,
  observations: Observations,
  floorMatches: boolean,
): TriageConflict | null {
  // Under-classification: a security signal is present but the model chose a
  // passive category, and the floor won't already fix it. The dangerous miss.
  if (
    observations.content.hasSecurityKeyword &&
    PASSIVE_CATEGORIES.has(classification.category) &&
    !floorMatches
  ) {
    return {
      kind: "under_classification",
      message: `A security-related signal was detected in the body, but you classified this as "${classification.category}" (a passive category). Security/account signals usually warrant urgent or action_needed unless this is clearly self-initiated auth or routine advisory bot noise.`,
    };
  }

  // Over-classification: the model spiked to an important category for a sender
  // whose prior is overwhelmingly bulk, with nothing supporting the severity.
  if (
    IMPORTANT_CATEGORIES.has(classification.category) &&
    !observations.content.hasSecurityKeyword &&
    !observations.gmail.important
  ) {
    const { total, bulkShare } = priorBulkProfile(observations.senderPrior.categoryCounts);
    if (total >= STRONG_BULK_MIN_TOTAL && bulkShare >= STRONG_BULK_MIN_SHARE) {
      return {
        kind: "over_classification",
        message: `You classified this as "${classification.category}", but this sender is historically bulk mail (${Math.round(bulkShare * 100)}% of ${total} prior messages were newsletter/marketing/fyi/done), Gmail did not mark it IMPORTANT, and no security signal is present. Promotional-urgency language ("act now", "last chance") is not a real deadline — confirm this is genuinely actionable.`,
      };
    }
  }

  return null;
}

/**
 * Override floor (ADR-0051 §5, Phase 3 seed = ONE signal). Forces `urgent` when
 * an exposed/leaked/committed secret is present, regardless of model output.
 * PURE. Returns the (possibly forced) classification and whether it changed.
 */
export function applyOverrideFloor(
  classification: TriageClassification,
  signalText: string,
): { classification: TriageClassification; forced: boolean } {
  if (!OVERRIDE_FLOOR_SECRET_RE.test(signalText)) {
    return { classification, forced: false };
  }
  if (classification.category === "urgent") {
    // Floor agrees with the model — no change, nothing to force.
    return { classification, forced: false };
  }
  return {
    classification: {
      ...classification,
      category: "urgent",
      confidence: Math.max(classification.confidence, 0.85),
      rationale: truncateRationale(
        `${classification.rationale} Override floor: an exposed secret/credential was detected — forced urgent.`,
      ),
    },
    forced: true,
  };
}

/** A resolved rail todo to mint — the cheap model's proposal after the gate. */
export type ResolvedTodoSuggestion = { name: string; assist?: string };

/**
 * Resolve the rail todo to mint from a FINAL classification (Phase 0 contract,
 * ADR-0050 amendment 2026-06-05). Returns the suggestion ONLY when the cheap
 * model proposed one AND the category is todo-eligible; the category gate
 * ({@link TODO_INELIGIBLE_CATEGORIES}) suppresses a stray suggestion the model
 * emitted on `marketing`/`newsletter`/`fyi`/`done` mail. PURE — the
 * `email-triage` tail step calls this and, on a non-null result, writes the
 * todo via `suggestTodo`. The single decision point so the gate is testable
 * without a workflow harness and stays in lockstep with the prompt's rule 16a.
 */
export function resolveTodoSuggestion(
  classification: TriageClassification,
): ResolvedTodoSuggestion | null {
  const suggestion = classification.todoSuggestion ?? null;
  if (!suggestion) return null;
  if (TODO_INELIGIBLE_CATEGORIES.has(classification.category)) return null;
  return suggestion;
}

/** Concatenated lowercased text the floor predicate scans (subject + body + snippet). */
function floorSignalText(document: ClassifyEmailArgs["document"]): string {
  const parts: string[] = [];
  if (document.title) parts.push(document.title);
  parts.push(document.content);
  const snippet = document.metadata.snippet;
  if (typeof snippet === "string") parts.push(snippet);
  return parts.join("\n").toLowerCase();
}

/**
 * Run the context-rich classify sequence over a single email: first cheap pass
 * → conditional second pass on a detected conflict → override floor. Returns
 * the final classification, the resolved model id, and an audit trail.
 */
export async function classifyEmail(
  args: ClassifyEmailArgs,
): Promise<{ classification: TriageClassification; model: string; audit: ClassifyAudit }> {
  const useInjected = Boolean(args.runPass);
  const model = useInjected ? null : getCheapModel();
  const baseModelId = useInjected ? "injected" : resolveModelId(model);
  const runPass: RunPass = args.runPass ?? defaultRunPass(model, args);

  const floorMatches = OVERRIDE_FLOOR_SECRET_RE.test(floorSignalText(args.document));

  const firstPass = await runPass({
    system: SYSTEM_PROMPT,
    prompt: userPrompt(args, null),
    pass: "first",
  });

  const conflict = detectConflict(firstPass, args.observations, floorMatches);
  let working = firstPass;
  let secondPass: TriageClassification | null = null;
  if (conflict) {
    secondPass = await runPass({
      system: SYSTEM_PROMPT,
      prompt: userPrompt(args, conflict),
      pass: "second",
    });
    working = secondPass;
  }

  const floorResult = applyOverrideFloor(working, floorSignalText(args.document));
  const classification = floorResult.classification;

  let model_id = baseModelId;
  if (secondPass) model_id += "+2pass";
  if (floorResult.forced) model_id += "+floor";

  return {
    classification,
    model: model_id,
    audit: { firstPass, conflict, secondPass, floorForced: floorResult.forced },
  };
}

/** Build the production cheap-model pass runner (metered, Zod-validated). */
function defaultRunPass(
  model: ReturnType<typeof getCheapModel> | null,
  args: ClassifyEmailArgs,
): RunPass {
  return async ({ system, prompt, pass }) => {
    if (!model) throw new Error("[triage] classifyEmail: no cheap model and no runPass injected");
    const result = await meteredGenerateObject<TriageClassification>(
      {
        model,
        system,
        prompt,
        schema: triageClassificationSchema,
        temperature: 0,
        // Triage answers are tiny — cap hard so a misbehaving model can't burn
        // tokens on a wall-of-text rationale.
        maxOutputTokens: 400,
      },
      {
        role: "triage",
        userId: args.userId,
        runId: args.runId,
        stepId: args.stepId,
        // Distinct idempotency key per pass so the second pass isn't deduped
        // against the first within the same attempt.
        idempotencyKey: args.idempotencyKey ? `${args.idempotencyKey}:${pass}` : undefined,
        requestMeta: {
          purpose: pass === "second" ? "triage.classify.second_pass" : "triage.classify",
          documentId: args.document.id,
        },
        name: pass === "second" ? "triage.classify.second_pass" : "triage.classify",
      },
    );
    return result.object;
  };
}

function truncateRationale(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function resolveModelId(model: unknown): string {
  if (typeof model === "object" && model && "modelId" in model) {
    const id = (model as { modelId: unknown }).modelId;
    return typeof id === "string" ? id : String(id);
  }
  return "unknown";
}

/** Default category for failure paths — keep it as `fyi` so we never drop a message untriaged. */
export const DEFAULT_TRIAGE_CATEGORY: TriageCategory = "fyi";
