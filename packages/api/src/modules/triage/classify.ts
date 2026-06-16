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

/**
 * Todo-worthiness rubric outcomes (ADR-0050 amendment 2026-06-06). Reports which
 * of the five ordered rubric tests (rule 16) decided the todo call: `proposed`
 * only when all pass, otherwise the FIRST test that failed. Logged to
 * `triage.sender_extraction` so the rubric is tuned from real misses (which
 * dimension fails on which class of mail), not by appending example #N.
 */
export const TODO_DECISION_OUTCOMES = [
  "proposed",
  "no_obligation",
  "not_significant",
  "would_not_forget",
  "too_vague",
  "already_handled",
] as const;
export type TodoDecisionOutcome = (typeof TODO_DECISION_OUTCOMES)[number];

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
   * Real-time todo proposal for the rail (ADR-0050, amended 2026-06-06 to the
   * todo-worthiness rubric). Non-null ONLY when the email clears all five rubric
   * tests (rule 16) — the email-triage tail step turns it into a `suggested`
   * todo via `system.suggest_todo`. The decision is ORTHOGONAL to the category
   * and evaluated over the whole email (a `done` closure with a significant
   * trailing ask can still yield one); `todoDecision` reports which test fired.
   * The model must always emit the key (null when no todo) — this is one field
   * on the existing cheap call, not a second call.
   */
  todoSuggestion: z
    .object({
      /** Crisp imperative title for the rail checkbox row. */
      name: z.string().min(1).max(120),
      /**
       * Optional one-liner on how to approach it, or an honest "can't act yet".
       * `.nullish()` (not `.optional()`): the prompt tells the model `assist` is
       * null BY DEFAULT, so flash-lite routinely emits explicit `null` — which a
       * bare `.optional()` rejects, throwing AI_NoObjectGeneratedError.
       */
      assist: z.string().max(280).nullish(),
    })
    .nullable()
    // Optional on the TYPE so non-cheap-classifier producers need not set it;
    // the cheap call is prompted to always emit it (null when no todo).
    .optional(),
  /**
   * Always-present rubric trace (ADR-0050 amendment 2026-06-06). Reports which
   * rubric test decided the call, so a wrong suggestion AND a wrong *omission*
   * are both debuggable by dimension. Invariant: `outcome === 'proposed'` iff
   * `todoSuggestion` is non-null. Optional on the TYPE for non-cheap-classifier
   * producers; the cheap call is prompted to always emit it.
   */
  todoDecision: z
    .object({
      outcome: z.enum(TODO_DECISION_OUTCOMES),
      /**
       * Optional ≤1-clause detail for the log (e.g. "trivial survey"). `.nullish()`
       * (not `.optional()`) so an explicit `"note": null` from the model is accepted
       * rather than throwing on schema mismatch.
       */
      note: z.string().max(200).nullish(),
    })
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
  /**
   * Minimal identity signal (ADR-0050/0051 amendment 2026-06-09) — the user's
   * display name + the account email being triaged. The ONLY user-identity the
   * cheap classifier gets: it powers the todo ownership-attribution gate (rule
   * 16a) so an action the email assigns to a *named third party* is not minted
   * as the user's todo (the "Sakshi standup" bug). Deliberately NOT role /
   * projects / relationships — those stay parked under ADR-0050 D1. The first
   * surgical brick toward the full `User context` projection.
   */
  identity?: { name?: string | null; email?: string | null };
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
  secondPassFailure: { message: string } | null;
  /** True when the override-floor signal matched, even if the model already said urgent. */
  floorMatched: boolean;
  /** True when the override floor forced a category change (not merely matched). */
  floorForced: boolean;
}

const PASSIVE_CATEGORIES = new Set<TriageCategory>(["fyi", "done", "newsletter", "marketing"]);
const IMPORTANT_CATEGORIES = new Set<TriageCategory>(["urgent", "action_needed"]);
/**
 * Categories that NEVER carry a rail todo regardless of model output (ADR-0050
 * amendment 2026-06-06). Shrunk to `{marketing, newsletter}`: these are the
 * broadcast buckets where a genuine personal obligation would be, by definition,
 * a MISCLASSIFICATION leaking through — so this is a CONSISTENCY GUARD against
 * classifier leakage, not a relevance judgment. `fyi`/`done` deliberately do NOT
 * live here: an `fyi` can carry a real obligation ("auto-renews unless you
 * cancel") and a `done` closure can end with a significant trailing ask — both
 * go through the rubric (rule 16), which owns the todo decision everywhere else.
 */
const TODO_INELIGIBLE_CATEGORIES = new Set<TriageCategory>(["marketing", "newsletter"]);
/** Categories that count toward a sender's "bulk" share for the over-classification net. */
const BULK_PRIOR_CATEGORIES = new Set<string>(["newsletter", "marketing", "fyi", "done"]);
const STRONG_BULK_MIN_TOTAL = 5;
const STRONG_BULK_MIN_SHARE = 0.8;
const OVERRIDE_FLOOR_CONFIDENCE_FLOOR = 0.85;
const SECOND_PASS_FAILURE_CONFIDENCE_FLOOR = 0.6;
const MAX_RATIONALE_LEN = 500;

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
const OVERRIDE_FLOOR_SECRET_NOUN = String.raw`(?:secret|api[ -]?key|token|private key|password)`;
const OVERRIDE_FLOOR_EXPOSURE_VERB = String.raw`(?:exposed|leaked|committed|compromised|found|detected)`;
const OVERRIDE_FLOOR_SECRET_RE = new RegExp(
  String.raw`\b(?:${OVERRIDE_FLOOR_SECRET_NOUN}\b[\s\S]{0,100}\b${OVERRIDE_FLOOR_EXPOSURE_VERB}|${OVERRIDE_FLOOR_EXPOSURE_VERB}\b[\s\S]{0,100}\b${OVERRIDE_FLOOR_SECRET_NOUN})\b`,
  "i",
);

const SYSTEM_PROMPT = `You triage emails for a personal assistant. Classify each email into EXACTLY ONE category:

- urgent: action needed within hours, not days. Unsolicited security alerts (unrecognized/suspicious sign-in "was this you?", password or 2FA changed without the user, account compromised), billing failure that breaks access today, deadline today, critical CI/CD blocking ship. NOT a routine login link or code the user requested themselves — that is fyi (rule 15).
- action_needed: the user must take a concrete step that isn't time-critical. Reply, decide, complete a task, rotate a credential, update a card before its actual deadline, verify identity, fix a broken build, respond to a code review. (Self-initiated sign-in/magic links, one-time login codes, and email-verification the user just requested are NOT here — they are fyi per rule 15.)
- follow_up: a soft check-in or nudge on a prior thread — "any update on...?", "circling back", "just following up." The sender already knows the user is aware; they're probing for status.
- awaiting_reply: someone is asking the user a direct first question, and the only action is to write back. Pick this when no prior thread exists or the message is a fresh ask.
- meeting: a meeting the user is expected to attend, prepare for, schedule, reschedule, or answer availability for. Direct calendar invites, agenda/prep emails for the user's meeting, room/availability negotiations, and "your meeting starts soon" pings.
- fyi: passive awareness items. Self-initiated sign-in/magic links, one-time login codes, and email-verification the user just requested (rule 15), resolved-incident status posts, product release notes without action, social activity digests, "we updated our terms" notices, GitHub notifications that don't require review, legal/investor/shareholder notices with no user action.
- done: explicit closure or completion notice — the user's underlying request/loop is RESOLVED. Order shipped, payment received, deploy succeeded, ticket resolved, "your request has been processed." A task/ticket being CREATED, FILED, OPENED, logged, or "added to the backlog" is the START of work, NOT a closure — never \`done\`, even when an automation reports "Done" about having created it ("Brain: Done. Created [task] in the backlog" = the bot finished FILING the task, the user's request is now OPEN, not resolved). Route task creation by ownership (rule 12e), never to \`done\`.
- payment: invoices, receipts that need attention, payment failures, billing notices, refunds, statements.
- newsletter: subscription content the user opted into — weekly digests, Substack posts, professional newsletters, automated content publication.
- marketing: promotional / sales blasts. "20% off this weekend", product launches, public brand events/webinars/keynotes, cold outbound sales, growth-team nurture sequences.

How to use the Observations block:
- The observations are DETERMINISTIC CONTEXT — hints to focus your attention, never verdicts. You still decide the category from the email itself.
- Sender prior is this sender's past category histogram. A 99%-newsletter sender can still send one genuinely urgent message — trust the message over the prior when they disagree. The prior breaks routine ties, it does not override a clear signal.
- Account persona (work/personal) frames what "urgent"/"action_needed" mean for this account.
- Thread state ("you last replied on <date>") and the recent-thread-messages excerpts are context for follow_up vs awaiting_reply vs done — not a deterministic mapping. You classify the WHOLE THREAD and a new message OVERWRITES the thread's single tag, so read the recent messages: if an earlier one carries a live, unanswered ask or assignment to the user, a trailing low-signal line (a bot confirming it filed a task, an acknowledgement, a reaction) must NOT bury it.
- Known contact = the sender is in the user's contacts. A direct ask from a known contact is more likely a real awaiting_reply/action_needed.
- Sender relationship (when present) describes the user's correspondence history WITH this sender: significance (strong/moderate/weak), reciprocity (two-way / you reached out / one-way inbound — the user never replied), same-org, and the user's own role. \`no prior contact on record\` means a cold sender with NO history. This is the ONLY way to judge whether a real PERSON is waiting on the user (todo rubric 16b): a weak / one-way / no-prior-contact sender is a cold contact, NOT a real stakeholder, however the email is phrased. Never infer a relationship beyond what this line states. It does NOT change the category — a cold ask is still an honest awaiting_reply; it only gates the todo.
- Gmail signals (categories, IMPORTANT, STARRED) are Gmail's own priors — lean on them when they align.
- Content flags are cheap regex tells: unsubscribe → newsletter/marketing; currency → payment; security → look harder at severity; calendar → meeting; investorNotice → rule 9; publicEvent → rule 8. They are signals to weigh, not commands.

Rules:
1. Pick exactly one category — the dominant one if multiple apply.
2. Time-pressure: prefer 'urgent' over 'action_needed' when consequence-of-delay is hours-not-days (account compromise, security breach, billing failure that breaks access today). A login link or code merely expiring is NOT such a consequence — the user just requests a fresh one.
3. Reply-shape: prefer 'awaiting_reply' over 'action_needed' when the action IS the reply.
4. Reply-shape (continued): prefer 'follow_up' over 'awaiting_reply' when the sender is nudging on an existing thread, not opening a new ask. "Any update?" / "Just circling back" → follow_up.
5. Closure: prefer 'done' over 'fyi' when the message explicitly marks something as finished/shipped/resolved/succeeded. 'fyi' is for informational items that don't close a loop. Closure means the USER'S underlying request/loop is resolved — NOT that an intermediate actor reported finishing a sub-step. Creating, filing, or opening a task/ticket (even one phrased "Done. Created …") OPENS a loop; it is never closure.
6. Promo split: prefer 'marketing' over 'newsletter' for unsolicited promotional blasts, sales pitches, cold outbound, public product launches, brand events, webinars, and keynotes. 'newsletter' is for subscribed editorial/digest content the user opted into.
7. Meeting gate: choose 'meeting' only when the user is a participant or likely participant in a personal/work calendar-style meeting. The words "meeting", "event", "conference", "webinar", "keynote", "AGM", or "annual general meeting" are NOT enough by themselves.
8. Bulk/public event rule: public events, brand announcements, product launches, webinars, conferences, keynotes, and "save the date" blasts are marketing/newsletter/fyi, not meeting, unless the email is a direct calendar invite or scheduling thread for the user. (The publicEvent content flag marks this language.)
9. Investor/legal notice rule: stock-market, shareholder, AGM, proxy/e-voting, annual report, exchange filing, and registrar/depository notices are usually 'fyi'. Use 'action_needed' only when the email asks the user to vote, register, submit a form, make a decision, or meet a concrete deadline. Do not use 'meeting' for a corporate AGM notice just because the notice says "meeting". (The investorNotice content flag marks this language.) More broadly — manufactured or ceremonial urgency (engagement/gamification nudges, "save the date" galas, AGMs) is 'fyi' (or 'marketing') unless it imposes a concrete action + deadline on the user; never 'meeting'/'urgent' on ceremony or a manufactured stake alone.
10. 'meeting' takes precedence over 'action_needed' / 'awaiting_reply' only after the Meeting gate is satisfied.
11. 'payment' takes precedence over 'fyi' / 'done' for any financial transaction notice.
    11a. Owed vs upsell — the discriminator is whether MONEY IS OWED, not whether money is mentioned. Mail that pressures the user to START or EXPAND paid usage — "upgrade your plan", "you've hit your free/trial quota", "trial ending", "unlock more", "running low on credits", "add a seat", "continue receiving X — upgrade" — is OPTIONAL conversion pressure the vendor MANUFACTURES; nothing is owed → 'marketing' (a plain neutral usage/quota notice with no pitch → 'fyi'), NEVER 'payment'/'action_needed'/'urgent', however the quota cap or "to continue" framing is phrased. Money is OWED only on an EXISTING paid relationship — "payment failed", "card declined", "invoice due", "subscription past due", "your card will be charged $X on <date>" — which is 'payment' (rule 11), and 'urgent'/'action_needed' when access breaks. A freemium product hitting its free ceiling (Greptile/Vercel/Linear "upgrade to keep using it") is upsell, not a bill — this holds whether the sender is the vendor directly or a '[bot]' relay (rule 12a still applies). A manufactured DEADLINE on an upsell — "trial ends tomorrow", "capped — act by <date>", "tracking ends soon", "upgrade before you lose the free tier" — does NOT promote it to 'urgent' or 'payment': the deadline is the vendor's CONVERSION lever (manufactured scarcity, rule 16b), not a consequence-of-delay on a commitment the user made. Losing a FREE tier the user never paid for is not the access-loss rule 2 means; stay 'marketing'/'fyi' however near the date.
12. Automated/service mail:
    12a. Bot review comments — any SenderContext.effectiveAuthor='bot' (a GitHub '[bot]' account such as greptile-apps[bot], coderabbit, copilot-review, github-actions, dependabot, renovate, or any other) — are advisory review noise by default → 'fyi', even when they contain suggested fixes or CVE identifiers. Do not gate on a specific bot name.
    12b. Escalate a bot review comment to 'action_needed' or 'urgent' only when the body itself shows severe impact: exposed secret/token/key, auth bypass, data loss, production outage, blocked deploy, or a same-day security/account deadline.
    12c. Severity-suspect bot alerts where botSlug is sentry, stripe-billing, google-security, vercel, or datadog should be classified from body content alone: 'urgent' if same-day actionable, 'action_needed' if remediation is needed but not immediate, otherwise 'fyi'/'done'.
    12d. Unknown service envelopes classify from body content alone.
    12e. Activity-feed notifications from collaboration tools — task/issue trackers (ClickUp, Linear, Asana, Jira, Trello, Monday, Notion, GitHub Issues), doc/design comment threads (Google Docs/Drive, Figma, Confluence), and support/CRM/chat notifications (Zendesk, Intercom, Slack/Discord mention forwards) — share one trap: the SUBJECT is the work ITEM'S name (frequently an imperative task title like "Fix X" or "Debug Y"), NOT an instruction to the user. Classify from the BODY event and OWNERSHIP, never the subject. Use the "You (the user being triaged)" block to decide ownership. Use 'action_needed'/'awaiting_reply' ONLY when the body shows the item is ASSIGNED to the user, the user is @-mentioned with a concrete ask, or a reply is owed BY the user. A third-party comment, a status change, or activity on an item the user merely watches / is CC'd on → 'fyi'; an explicit closure ("resolved", "moved to Done", "nothing to do here") → 'done'. A task/ticket being CREATED, FILED, OPENED, or added to a list/backlog — INCLUDING an AI/bot replying "Done. Created [task] …" — is the OPENING of work, never 'done': route it by ownership exactly like any other item (assigned to / @-mentioned the user with a concrete ask → action_needed; a direct unanswered question → awaiting_reply; pure activity on someone else's item → fyi). Use the recent-thread-messages context to find the ownership: a trailing "task created" line whose thread shows the user was asked to fix/handle the item stays action_needed. Inside a product team's task comment, "the user"/"the customer" means an END USER of the product, NOT the email recipient — never read it as an obligation on the recipient.
13. Confidence:
    - 0.9+: unambiguous (newsletter from a clearly subscribed sender, payment receipt with amount, secret-scanning alert from GitHub).
    - 0.7-0.9: clear category but with some overlap.
    - 0.5-0.7: educated guess; pick the best fit but flag uncertainty.
    - Below 0.5: only when no category fits well; still pick the closest one. Low scores get surfaced to the user as "alfred wasn't sure."
14. Rationale: 1-2 sentences citing concrete cues (sender, subject phrasing, body content, a decisive observation). Don't restate the rule.
15. Self-initiated authentication mail — sign-in / magic links, one-time login codes (OTP), and email-address verification the user just requested — is fyi, not action_needed and not urgent. The user initiated it and is already mid-flow; it expires harmlessly, carries no consequence-of-delay, and by the time it surfaces the action is moot — nothing to track, nothing to remember. Reserve urgent for UNSOLICITED security alerts: an unrecognized sign-in, a "was this you?" challenge, or a password/2FA change the user did not make.
16. Todo suggestion (rail) — decide, SEPARATELY from the category, whether this email puts a commitment on the USER worth tracking on their todo rail. This is orthogonal to the category: evaluate the WHOLE email — including a secondary or trailing ask — and do NOT bend the category to fit it (a closure email that ends with a real request stays \`done\` AND may still yield a todo). A todo is a MEMORY AID: it earns its place only if the user could plausibly forget or drop it. Most actionable mail does not clear this bar.
    Apply five tests IN ORDER. Stop at the first that fails; report it in \`todoDecision.outcome\`. Only an email that passes all five gets a \`todoSuggestion\`.
    16a. Obligation on me (gate) — is there an action AND does the USER own it? Two ways to fail. (i) No action falls on the user: pure awareness, the sender's job, an invitation/opportunity/optional nicety, or a product nudging engagement → outcome \`no_obligation\`. A social-network connection request (LinkedIn/X/etc. — "wants to connect", "I want to connect", "would like to join your network") is the canonical optional nicety: the sender's want, not your obligation, and any urgency it phrases is THEIRS → \`no_obligation\` — regardless of the requester's stated title or seniority. A cold "Founder & CEO wants to connect" is still the sender's want, not the user's obligation; whether a connection or any other cold ask is worth a todo is decided by 16b's person-waiting test (the Sender relationship observation), NOT by the title in the email. (ii) The action is real but the email assigns it to a DIFFERENT person: use the "You (the user being triaged)" block to know who you are, then check the owner — if the body hands the task to someone who is not the user ("Sakshi is running standup", "@alice please review the PR", "Karthik to send the deck"), the obligation is THEIRS, not the user's → outcome \`no_obligation\` (note who owns it). A newsletter or shipped-order notice leaves no ball in the user's court; an FYI that says "auto-renews in 30 days unless you cancel" DOES.
    16b. Significance — a REAL, EXTERNAL stake. The obligation must carry a real stake, one of: a real identifiable person waiting on the user; money owed or at risk; a hard deadline; loss of access; a commitment the user made to a human; OR a real-world consequence to the user judged from the content. That last clause is the ONLY way automated/bot mail earns a todo, and for code/PR/review findings (whether from a bot OR a human reviewer) it turns on LIVENESS — is something ALREADY LIVE at stake? A real stake = the issue affects PRODUCTION or already-merged (\`main\`) code: a secret already committed/exposed, a vulnerability in \`main\`, an outage, a broken or blocked production deploy, a same-day security deadline. NO stake = the issue exists only in the UNMERGED changes under review — nitpicks, style, perf suggestions, even a genuine vulnerability that lives only in the PR's proposed code and is not yet in \`main\`/production. That is pre-merge advisory (review working as intended; nothing live is at risk) → fail. The test is not "is a reviewer waiting" but "is something already live at stake." MECHANICAL RULE: a pull-request review comment — anything of the shape "<reviewer> commented on PR #N", "address the review feedback on PR #N", "apply these suggestions" — is BY DEFINITION about code not yet merged, so it is pre-merge advisory and emits NO todo (outcome \`not_significant\`, note \`advisory:\`), REGARDLESS of how concrete or severe the suggested fixes sound, UNLESS the body explicitly says the problem is already in production / \`main\` or a credential is already exposed. CodeRabbit/Greptile "consider…" comments and CVE-FYIs fail. Stakes a product MANUFACTURES to drive engagement OR conversion — gamification streaks ("play before midnight or lose your streak"), unread/notification counts, "N people viewed your profile", marketing scarcity ("ends tonight"), and upsell/quota pressure ("upgrade your plan", "trial ending", "you've hit your free quota", "upgrade to continue") where nothing is actually owed (rule 11a) — and CEREMONIAL obligations (AGM, "save the date") are NOT real stakes, however urgently phrased → outcome \`not_significant\` (set \`note\` prefix \`manufactured:\` or \`advisory:\`). Real-but-trivial asks also fail: rate-your-driver, surveys, "thoughts sometime?", optional feedback. Judge the INTRINSIC stakes — money owed/at-risk, a hard deadline, lost access, a commitment to a human, code/PR liveness — from the email content; they hold regardless of who sent it. The ONE stake you may NOT take from content alone is "a real identifiable PERSON is waiting on the user": it must be CORROBORATED by the Sender relationship observation. A weak / one-way-inbound / \`no prior contact on record\` sender is a cold contact, NOT a real person waiting — a cold ask ("give me a recommendation", "I want to connect", "can you intro me?", "endorse me") fails here however directly it is phrased and whatever the sender's stated title → outcome \`not_significant\` (note prefix \`cold_sender:\`). A strong / two-way relationship — or a known contact with real history — asking a direct question IS a real person waiting → passes. When NO Sender relationship line is present (a bot/service sender), there is no person waiting: judge only the intrinsic stakes. Never infer a relationship the observation does not state.
    16c. Memorability. Would the user plausibly FORGET or DROP this if it is not tracked — or will they obviously handle it now / does it resolve itself? Self-initiated authentication mail (the rule-15 class: sign-in/magic links, one-time codes, email verification the user just requested), expiring codes, "thanks!", anything the user is already mid-flow on → nothing to remember → outcome \`would_not_forget\`. A todo here is noise.
    16d. Actionability. Can you write a SPECIFIC, self-contained action from the email alone? A vague ask ("something broke, please fix it" with no what/where, "let's catch up sometime", a problem report missing specifics) → outcome \`too_vague\`. A vague rail item is worse than none.
    16e. Already handled. Does thread state show the user already replied/acted, or the loop is closed with no new ask? → outcome \`already_handled\`.
    16f. All five pass → outcome \`proposed\` and set \`todoSuggestion\`. Write \`name\` the way the USER would jot it on a sticky note to themselves — short, plain, object-first — NOT the way the email phrased it. It is a second-person IMPERATIVE that leads with the real verb and names the object, ideally 3–6 words and HARD-CAPPED at 8: "Reply to Priya about Q3 budget", "Rotate the exposed Redis credential", "Add receipts to 4 Brex expenses", "Pay the Zerodha AMC charge". Strip scaffolding the user already knows from context — drop "request"/"notification"/"connection"/"on <Platform>" filler and the email's formal phrasing: "Reply to Ankur on LinkedIn", NOT "Respond to the LinkedIn connection request from Ankur Singh". Fold a count straight into the name ("Fix 3 blocking issues in PR #78", not name + "three items" in assist). NEVER a bare verb ("Log in", "Reply"), and NEVER a hedge or passive frame ("Review and address…", "Look into…", "Provide info for…", "Address the … on …", "Investigate the …") — name the actual action. \`assist\` is null BY DEFAULT — the \`name\` is the whole todo, and a sentence under it is just more for the user to read. Populate \`assist\` ONLY with a HARD FACT the name structurally cannot carry — a money amount, a hard deadline/date, or a genuine either/or decision — and then ONLY as a TERSE FRAGMENT, never a sentence: "₹88.5 · due Jun 11", "before Jun 30", "renews Jul 1 — keep or cancel". Always write a date as an ABSOLUTE calendar date ("Jun 11", "Jul 1") — NEVER a relative word like "tomorrow", "tonight", "today", or "next Friday". A rail todo persists for days, so "due tomorrow" is a lie the moment it goes stale; resolve any relative phrasing in the email against the email's Date shown above and write the actual date. NO verbs, NO restating the name, NO mechanical step ("click the link", "check the logs", "review the profile", "secure the account") — those are noise and MUST be null. When in doubt, null. Never invent specifics absent from the email.
    16g. ALWAYS emit \`todoDecision\`: { "outcome": <one of the six above>, "note"?: "<≤1 short clause if useful>" }. \`todoSuggestion\` is null unless outcome is \`proposed\`.
17. Thread tag is the LIVE loop, not the last keystroke. The thread carries ONE tag and the newest message rewrites it for the whole thread. Do not let a trailing low-signal message — an automation/bot status line ("Done. Created the task", "moved to In Progress"), an acknowledgement, or a reaction — overwrite an open ask from earlier in the thread. When the recent-thread-messages show the user was assigned a task or asked a direct question that is still unanswered, the thread stays \`action_needed\`/\`awaiting_reply\` even when the latest line is a bot's "done". Judge what the thread still needs FROM THE USER, not the wording of the final line.

Examples (subject → category):
- "[acme/repo] Redis URI exposed on GitHub" from noreply@github.com → urgent (credential must be rotated today).
- "Sign-in attempt from a NEW device — was this you?" from security@google.com → urgent (unsolicited compromise alert).
- "Sign in to Anthropic" / "Your login code is 123456" / "Verify your email address" the user just requested → fyi (self-initiated auth, expires harmlessly, action is moot by the time it surfaces — rule 15, NOT action_needed, NOT urgent), and no todo (rule 16c memorability — nothing to remember).
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
- "**greptile-apps[bot]** commented: 99Yash has reached the 50-review trial limit — upgrade your plan to continue" → marketing (rule 11a: upsell, nothing owed; the trial cap is manufactured conversion pressure, NOT a bill — never payment/action_needed). Contrast "Your Greptile subscription payment failed" → payment.
- "Conservice : Fix deal views resetting after saving" from ClickUp/Linear, body is a third-party comment "Nothing to be done here — product gap for the user" → done (rule 12e: closure on someone else's investigation; the subject is the task NAME, not your action, and "the user" is the product's end user).
- "Fix login redirect loop" from a task tracker, body "Akshay assigned this to you · due Jun 14" → action_needed (rule 12e: the body shows the item is owned by the user).
- ClickUp/Linear bot, body "Brain: Done. Created [Fix imports not triggering deal driver messages] in the 26.3 Backlog list", recent-thread-messages show "dvd assigned you a comment: there is still a bug … please make sure this is fixed" → action_needed, NOT done (rules 5/12e/17: filing a backlog task OPENS work, and the thread shows a live bug assigned to the user — the bot's "Done" is the filing, not the fix). With NO such earlier ask in the thread, the same line is fyi (a task was filed; awareness only) — never done.
- "Errors spiking in production" from Sentry → urgent/action_needed depending on immediacy and the user's project context.
- "Weekly digest from Substack: 5 stories" → newsletter (subscribed content).
- "20% off everything this weekend only!" from a retailer → marketing (promotional blast).
- "See you next week." from Apple / Inside Apple with WWDC or product-event content → marketing (public brand event, not the user's meeting).
- "Join our launch webinar on Thursday" from a vendor → marketing (public event blast, not a personal meeting).
- "Sundram Fasteners Limited — 63rd Annual General Meeting..." from a registrar/depository → fyi (shareholder/legal notice, not the user's meeting).
- "Proxy voting closes tomorrow — cast your vote" from a registrar/depository → action_needed (concrete user action/deadline).
- "Design review moved to 3pm — can you attend?" from a colleague/client → meeting (user participation/scheduling).

Todo-decision exemplars (each illustrates the ONE rubric test that decides it — note category and todo can disagree):
- "Sign in to Anthropic" / "Your login code is 123456" the user requested → no todo (16c memorability: self-initiated, nothing to remember).
- "Rate your recent delivery" / "How did we do? Leave a quick review" → no todo (16b significance: real ask, but trivial, no stake).
- Amazon "Your order shipped" ending "…complete this 1-question survey" → category done, no todo (16b significance).
- Client "Order shipped — also, please send the signed SOW by Friday" → category done, todo "Send the signed SOW to <client> by Friday" (16a+16b+16c all pass; category and todo disagree).
- Vendor FYI "Your plan auto-renews on Jul 1 unless you cancel" → category fyi, todo "Decide whether to cancel <vendor> before the Jul 1 auto-renew" (16a obligation holds on an fyi).
- "something broke on the site, can you look?" with no specifics → category action_needed, no todo (16d actionability: too vague).
- "Your 100-day Chess.com streak is paused — play before midnight" → no todo (16b: manufactured stake, a counter resetting is not a real consequence). Same for "You have 7 unread on Linear" / "5 people viewed your profile".
- Vendor/freemium "You've hit your free trial limit — upgrade your plan to continue" (Greptile/Vercel/Linear) → category marketing/fyi, no todo (11a + 16b: upsell, nothing owed, manufactured conversion stake). A real "Your invoice of $49 is past due" → category payment, todo only if action is owed and memorable.
- A PR review (bot OR human) asking to add a timeout, optimize an index, fix style, or even patch a vulnerability that exists ONLY in the unmerged PR → category fyi, no todo (16b liveness: pre-merge advisory, nothing in production at stake). BUT a secret already committed/exposed, a vulnerability in \`main\`, or a blocked production deploy → todo (16b: a live consequence).
- "Sakshi is running standup today while Dave is out" → category fyi/done, no todo (16a (ii): the action is owned by Sakshi, not the user — even though the user is the recipient).
- A task-tracker notification (ClickUp/Linear/Jira) whose body is a third-party comment or a status change on a task NOT assigned to the user → category fyi/done, no todo (16a (i): pure awareness — the imperative task TITLE in the subject is not the user's obligation). A todo only when the body assigns the task to the user or @-mentions them with a concrete ask.
- LinkedIn "I want to connect" → category action_needed (a direct request), no todo (16a (i): optional nicety — the sender's want, not the user's obligation — regardless of the headline title, "Founder & CEO" / "CTO" included; the title never earns a nudge).
- A cold ask — "give me a recommendation", "endorse my skills", "can you intro me?" — whose Sender relationship reads \`weak · one-way inbound\` or \`no prior contact on record\` → category awaiting_reply (an honest direct ask), no todo (16b person-waiting: a cold contact is not a real person waiting, note \`cold_sender:\`). The SAME ask from a \`strong · two-way\` contact (or a known contact with real history) → todo (a real person is waiting).
- "Sundram Fasteners — 63rd Annual General Meeting" from a registrar → category fyi, no todo (16b: ceremonial, no real stake) — unless it asks the user to vote by a deadline (then a todo).

Output JSON: { "category": "...", "confidence": 0.0-1.0, "rationale": "...", "todoSuggestion": { "name": "...", "assist": "..." } | null, "todoDecision": { "outcome": "proposed|no_obligation|not_significant|would_not_forget|too_vague|already_handled", "note": "..." } }`;

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

  if (obs.senderRelationship) {
    lines.push(`Sender relationship: ${obs.senderRelationship}`);
  }

  const t = obs.thread;
  if (t.messageCount > 0) {
    const replied = t.lastUserReplyAt
      ? `you last replied ${t.lastUserReplyAt.toISOString()}`
      : "you have not replied";
    lines.push(
      `Thread: ${t.messageCount} prior message(s); ${replied}; newest is ${t.newestDirection ?? "unknown"}`,
    );
    // Prior-message excerpts (newest first). The fed context that lets the
    // classifier of a trailing low-signal message see an earlier open ask in the
    // SAME thread (ADR-0051 amendment 2026-06-13). Labelled by direction so the
    // model knows which side spoke; "you sent" vs "you received".
    if (t.recentMessages.length) {
      lines.push(`Recent thread messages (newest first — the email below may be even newer):`);
      for (const m of t.recentMessages) {
        const who = m.direction === "sent" ? "you sent" : "received";
        lines.push(`  - [${who}] ${m.snippet}`);
      }
    }
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

  // Minimal identity for the ownership-attribution gate (rule 16a). One line,
  // name + account email; absent → the gate degrades to the model's best guess.
  const idName = args.identity?.name?.trim();
  const idEmail = args.identity?.email?.trim();
  if (idName || idEmail) {
    lines.push(
      `=== You (the user being triaged) ===\n${[idName, idEmail && `<${idEmail}>`].filter(Boolean).join(" ")}`,
    );
    lines.push("");
  }

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
): { classification: TriageClassification; matched: boolean; forced: boolean } {
  if (!OVERRIDE_FLOOR_SECRET_RE.test(signalText)) {
    return { classification, matched: false, forced: false };
  }
  if (classification.category === "urgent") {
    // Floor agrees with the model — no change, nothing to force.
    return { classification, matched: true, forced: false };
  }
  return {
    classification: {
      ...classification,
      category: "urgent",
      confidence: Math.max(classification.confidence, OVERRIDE_FLOOR_CONFIDENCE_FLOOR),
      rationale: truncateRationale(
        `${classification.rationale} Override floor: exposed secret material was detected — forced urgent.`,
      ),
    },
    matched: true,
    forced: true,
  };
}

/** A resolved rail todo to mint — the cheap model's proposal after the gate. */
export type ResolvedTodoSuggestion = { name: string; assist?: string };

// The rail title IS the todo; an `assist` line earns the user's eyes only if it
// carries a HARD FACT the title structurally can't — a money amount or a
// date/deadline. The cheap model reliably *extracts* those but will NOT reliably
// *self-censor*: it pads `assist` with URLs, prose, mechanical steps, and
// restatements. Prompting harder is whack-a-mole, so the keep/drop is enforced
// deterministically here instead. Anything that isn't a short amount/date
// fragment collapses to a title-only row.
const ASSIST_URL_RE = /https?:\/\//i;
const ASSIST_AMOUNT_RE =
  /[₹$€£¥]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:usd|eur|gbp|inr|rs\.?|rupees?|dollars?)\b/i;
const ASSIST_DATE_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b/i;
/** A real hard-fact fragment is short; longer means the model wrote a sentence. */
const ASSIST_MAX_LEN = 40;

// A rail todo persists for days, so a relative date word ("due tomorrow") reads
// as a lie the moment it goes stale — the absolute calendar date is always the
// better fact. The prompt tells the cheap model to resolve relative phrasing
// against the email's send date, but it won't reliably comply, so we enforce it
// here against the same anchor. `tonight`/`today` map to the send day; offsets
// are in days. Anything we can't resolve to a date is dropped (see below).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RELATIVE_DAY_OFFSETS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\btomorrow\b/gi, 1],
  [/\byesterday\b/gi, -1],
  [/\b(?:today|tonight)\b/gi, 0],
];
// Relative phrasing we can't pin to a single calendar day ("next Friday", "in 3
// days"). Left in place these go stale, so an assist that still contains one
// after resolution is dropped rather than shown.
const RESIDUAL_RELATIVE_RE =
  /\b(?:next|this|last)\s+(?:week|month|year|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\bin\s+\d+\s+(?:day|week|month)s?\b|\b(?:today|tonight|tomorrow|yesterday)\b/i;

/** Format a UTC date as a terse "Jun 11" fragment. PURE. */
function formatAssistDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Rewrite relative date words in an assist fragment to an absolute calendar date
 * anchored on the email's send time. Without an anchor the word can't be
 * resolved, so it's stripped — a stale relative date is worse than none. PURE.
 */
function resolveRelativeDates(text: string, anchor: Date | null): string {
  let out = text;
  for (const [re, offset] of RELATIVE_DAY_OFFSETS) {
    const replacement = anchor
      ? formatAssistDate(new Date(anchor.getTime() + offset * 86_400_000))
      : "";
    out = out.replace(re, replacement);
  }
  // Tidy separators/words left dangling by stripped dates ("₹88.5 · due " → "₹88.5").
  let cleaned = out.replace(/\s{2,}/g, " ").trim();
  let previous: string;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(/\s*(?:·|,|—|-|\bdue\b|\bby\b)\s*$/gi, "").trim();
  } while (cleaned !== previous);
  return cleaned;
}

/**
 * Keep `assist` only when it reads as a hard fact (an amount or an absolute date)
 * and is short enough to be a fragment, never a URL. Relative date words are
 * first resolved to an absolute date against `anchor` (the email's send time);
 * anything still relative afterward is dropped. Returns `undefined` otherwise so
 * the row renders title-only. PURE.
 */
export function sanitizeAssist(
  assist: string | null | undefined,
  anchor: Date | null = null,
): string | undefined {
  const trimmed = assist?.trim();
  if (!trimmed) return undefined;
  const text = resolveRelativeDates(trimmed, anchor);
  if (!text || text.length > ASSIST_MAX_LEN) return undefined;
  if (ASSIST_URL_RE.test(text)) return undefined;
  if (RESIDUAL_RELATIVE_RE.test(text)) return undefined;
  if (!ASSIST_AMOUNT_RE.test(text) && !ASSIST_DATE_RE.test(text)) return undefined;
  return text;
}

// Rule 16f bans hedge/passive todo titles ("Look into…", "Investigate the…",
// "View task…") and demands a real verb + object — but the cheap model keeps
// emitting them, and prompting harder is whack-a-mole (same reasoning as
// `sanitizeAssist`). So the clear cases are repaired deterministically here.
//
// SCOPE IS DELIBERATELY NARROW: only verbs with NO legitimate "the action IS
// this verb" reading. Stripping the prefix off "Investigate the X alarm" yields
// a strictly better object-led reminder ("X alarm"). Verbs that CAN be the real
// action — review (a contract), check (a number), confirm, verify, update,
// address — are EXCLUDED: auto-stripping them would destroy a legitimate title,
// so they stay model-owned via rule 16f. And we NEVER drop the todo: a hedged
// title still beats losing a real obligation (unlike `assist`, which is droppable).
const TODO_HEDGE_PREFIX_RE =
  /^(?:please\s+)?(?:look into|look at|dig into|take a look at|provide (?:info|information|details)|investigate|view)\b/i;
// Filler left dangling after the verb is stripped — a leading article, "into"/
// "at" preposition, or the "task" noun ("View task Eng…" → "Eng…").
const TODO_HEDGE_FILLER_RE = /^(?:the|a|an|this|that|into|at|on|for|about|tasks?)\s+/i;

/**
 * Repair an unambiguous hedge-shaped todo title into an object-led one (rule
 * 16f). Returns the original UNCHANGED when it isn't hedged or when stripping
 * would leave nothing usable — never empties or drops a real obligation. PURE.
 */
export function sanitizeTodoName(name: string): string {
  const trimmed = name.trim();
  if (!TODO_HEDGE_PREFIX_RE.test(trimmed)) return trimmed;
  let rest = trimmed.replace(TODO_HEDGE_PREFIX_RE, "").trimStart();
  let prev: string;
  do {
    prev = rest;
    rest = rest.replace(TODO_HEDGE_FILLER_RE, "").trimStart();
  } while (rest !== prev);
  rest = rest.replace(/^[\s:–—-]+/, "").trim();
  // A one-word or empty remainder means the hedge verb carried the meaning —
  // keep the original rather than mint a bare fragment.
  if (rest.split(/\s+/).filter(Boolean).length < 2 || rest.length < 4) return trimmed;
  // Capitalize a leading lowercase word ("baserow alarm" → "Baserow alarm").
  return /^[a-z]/.test(rest) ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest;
}

/**
 * Resolve the rail todo to mint from a FINAL classification (ADR-0050 amendment
 * 2026-06-06). Returns the suggestion ONLY when the cheap model proposed one
 * AND the category is todo-eligible; the floor ({@link TODO_INELIGIBLE_CATEGORIES},
 * now just `{marketing, newsletter}`) suppresses a stray suggestion that leaked
 * onto a broadcast bucket. The real todo decision is the rubric (rule 16) the
 * model already applied; this is a thin consistency guard, not the judgment.
 * The name is run through {@link sanitizeTodoName} to repair the hedge titles
 * the model emits despite rule 16f. PURE — the `email-triage` tail step calls
 * this and, on a non-null result, writes the todo via `suggestTodo`.
 */
export function resolveTodoSuggestion(
  classification: TriageClassification,
  emailAuthoredAt: Date | null = null,
): ResolvedTodoSuggestion | null {
  const suggestion = classification.todoSuggestion ?? null;
  if (!suggestion) return null;
  if (classification.todoDecision?.outcome !== "proposed") return null;
  if (TODO_INELIGIBLE_CATEGORIES.has(classification.category)) return null;
  const name = sanitizeTodoName(suggestion.name);
  const assist = sanitizeAssist(suggestion.assist, emailAuthoredAt);
  return assist ? { name, assist } : { name };
}

/** Why a structurally-disqualified email yields no rail todo even when the cheap model proposed one. */
export type TodoSuppressionReason = "alfred_approval" | "pre_merge_advisory";

const GITHUB_NOTIFICATION_RE = /notifications@github\.com/i;
// A GitHub PR-notification thread: the body carries a `/pull/N` link and the
// subject a `(PR #N)` ref. `/issues/N` and issue refs deliberately don't match —
// an issue can be a real ask; review of unmerged PR code is not (rule 16b).
const PR_THREAD_RE = /\/pull\/\d+|\bpull request\b|\bpr #\d+\b/i;
// Alfred's own human-in-the-loop approval mail: "[medium] Alfred wants to …".
const ALFRED_APPROVAL_SUBJECT_RE =
  /^\s*\[(?:no_risk|low|medium|high|critical)\]\s+alfred wants to\b/i;
// Liveness escape for the PR gate — something already in production / `main` /
// an exposed secret makes a PR thread a real stake (rule 16b), not advisory.
const TODO_LIVENESS_RE =
  /\bproduction\b|\bprod\b|\boutage\b|\bincident\b|\balready merged\b|\bin main\b|\bblocked deploy|\bdeploy(?:ment)? (?:failing|blocked|broken)\b/i;

/**
 * Structural disqualifier for a rail todo, applied AFTER the cheap model proposed
 * one (rule 16). The cheap model won't reliably self-apply 16b's liveness clause
 * or recognize Alfred's own approval mail, so two whole-row leaks are killed here
 * deterministically from the email's shape:
 *   - `alfred_approval`    — Alfred's own HIL approval request; it lives on the
 *                            Approvals surface, never the todo rail.
 *   - `pre_merge_advisory` — a GitHub pull-request notification thread with no
 *                            liveness signal (nothing in production / `main`, no
 *                            exposed secret). Reviewing unmerged code is not a todo.
 * Returns null when nothing disqualifies it. PURE — the mint path and the
 * dry-run both apply it so KEEP/KILL stays consistent.
 */
export function todoSuppressionReason(email: {
  sender: string | null;
  subject: string | null;
  signalText: string;
}): TodoSuppressionReason | null {
  if (ALFRED_APPROVAL_SUBJECT_RE.test(email.subject ?? "")) return "alfred_approval";
  if (GITHUB_NOTIFICATION_RE.test(email.sender ?? "") && PR_THREAD_RE.test(email.signalText)) {
    const live =
      TODO_LIVENESS_RE.test(email.signalText) || OVERRIDE_FLOOR_SECRET_RE.test(email.signalText);
    if (!live) return "pre_merge_advisory";
  }
  return null;
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

  const signalText = floorSignalText(args.document);
  const floorMatches = OVERRIDE_FLOOR_SECRET_RE.test(signalText);

  const firstPass = await runPass({
    system: SYSTEM_PROMPT,
    prompt: userPrompt(args, null),
    pass: "first",
  });

  const conflict = detectConflict(firstPass, args.observations, floorMatches);
  let working = firstPass;
  let secondPass: TriageClassification | null = null;
  let secondPassFailure: { message: string } | null = null;
  if (conflict) {
    // The second pass is an OPTIONAL re-check. A failure on it must NOT discard
    // the already-valid first pass: if the error propagated, the workflow's
    // catch would force the whole message to the default `fyi`, silently
    // DE-escalating a real urgent/action_needed (the exact opposite of what the
    // under-classification net is for). Fall back to the first pass instead.
    try {
      secondPass = await runPass({
        system: SYSTEM_PROMPT,
        prompt: userPrompt(args, conflict),
        pass: "second",
      });
      working = secondPass;
    } catch (err) {
      secondPassFailure = { message: errorMessage(err) };
      secondPass = null;
      working =
        conflict.kind === "under_classification"
          ? conservativeUnderClassificationFallback(firstPass, secondPassFailure.message)
          : firstPass;
    }
  }

  const floorResult = applyOverrideFloor(working, signalText);
  const classification = floorResult.classification;

  let model_id = baseModelId;
  if (secondPass) model_id += "+2pass";
  if (secondPassFailure) model_id += "+2pass_failed";
  if (floorResult.forced) model_id += "+floor";

  return {
    classification,
    model: model_id,
    audit: {
      firstPass,
      conflict,
      secondPass,
      secondPassFailure,
      floorMatched: floorResult.matched,
      floorForced: floorResult.forced,
    },
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
        // Bound the call so a hung/slow Gemini connection can't stall the
        // single-concurrency triage worker indefinitely. The workflow catches a
        // timeout and falls through to the default category (better a label than
        // a blocked queue).
        timeout: { totalMs: 30_000 },
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
  return value.length > MAX_RATIONALE_LEN ? `${value.slice(0, MAX_RATIONALE_LEN - 3)}...` : value;
}

function conservativeUnderClassificationFallback(
  firstPass: TriageClassification,
  message: string,
): TriageClassification {
  if (!PASSIVE_CATEGORIES.has(firstPass.category)) return firstPass;
  return {
    ...firstPass,
    category: "action_needed",
    confidence: Math.max(firstPass.confidence, SECOND_PASS_FAILURE_CONFIDENCE_FLOOR),
    rationale: truncateRationale(
      `${firstPass.rationale} Second-pass failed after a security under-classification conflict; conservatively escalated to action_needed. err=${message.slice(0, 160)}`,
    ),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
