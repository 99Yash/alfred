import {
  route,
  identifyLanguageModel,
  meteredGenerateObject,
  type LanguageModel,
  type MeteredGenerateObjectArgs,
} from "@alfred/ai";
import {
  TODO_DECISION_OUTCOMES,
  clamp01,
  collabActivitySchema,
  collapseWhitespace,
  confidenceSchema,
  documentAskProposalSchema,
  extractGmailDocumentBody,
  isOwnershipCollabActivity,
  isPassiveCollabActivity,
  sanitizeErrorMessage,
  triageTodoDecisionSchema,
  triageTodoSuggestionSchema,
  type CollabActivityKind,
  type GmailDocumentMetadata,
  type IanaTimezone,
  type SenderContext,
  type TodoDecisionOutcome,
  toMessage,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { selfIdentityGrounding } from "@alfred/assistant/settings";
import { TRIAGE_CATEGORIES, type TriageCategory } from "@alfred/integrations/google";
import { z } from "zod";
import { addDays, formatDay, inZone } from "@alfred/assistant/time";
import {
  TRIAGE_BODY_MAX_CHARS,
  TRIAGE_MAX_OUTPUT_TOKENS,
  TRIAGE_REQUEST_TIMEOUT_MS,
  TRIAGE_SERVICE_ACTION_LOOP_MIN_SHARE,
  TRIAGE_SERVICE_ACTION_LOOP_MIN_TOTAL,
  TRIAGE_STRONG_BULK_MIN_SHARE,
  TRIAGE_STRONG_BULK_MIN_TOTAL,
  TRIAGE_TODO_ASSIST_MAX_CHARS,
} from "./constants";
import {
  applyFloors,
  isGithubNotificationSender,
  matchesCollabIntrinsicStake,
  matchesExposedCredentialClaim,
  matchesExposedSecret,
  matchesPrThread,
  type FloorAudits,
} from "./floors";
import { createHedgeBudget, hedgeCeilingFor, runHedged, type HedgeBudget } from "./hedge";
import type { Observations } from "./observations";
import { MAX_RATIONALE_LEN, truncateRationale } from "./rationale";

// Defined in the leaf `rationale.ts` to avoid a `classify ↔ floors` cycle.
export { MAX_RATIONALE_LEN, truncateRationale };

/**
 * Email triage, cheap model always (ADR-0051): one cheap pass, an optional
 * second pass, then the deterministic floors.
 */

/** Which rubric test (rule 16) decided the todo call. In contracts so the row can store it. */
export { TODO_DECISION_OUTCOMES, type TodoDecisionOutcome };

export const triageClassificationSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  /**
   * [0, 1]. Below 0.5 the label still applies but is flagged as "alfred wasn't sure".
   * Bare number because some providers reject numeric bounds; `defaultRunPass` clamps it.
   */
  confidence: confidenceSchema,
  rationale: z.string().min(1).max(MAX_RATIONALE_LEN),
  documentAsk: documentAskProposalSchema.nullable().optional(),
  /**
   * Rail todo proposal (ADR-0050). Set only when all rubric tests (rule 16) pass.
   * Independent of the category: a `done` email can still carry one.
   */
  // Optional so other producers can skip them; the cheap call is prompted to always emit them.
  todoSuggestion: triageTodoSuggestionSchema.optional(),
  todoDecision: triageTodoDecisionSchema.optional(),
  /**
   * Collaboration-tool activity kind (#218); null for non-tracker mail. The
   * sender-kind floor demotes passive kinds and keeps work directed at the user.
   */
  collabActivity: collabActivitySchema.nullable().optional(),
});

export type TriageClassification = z.infer<typeof triageClassificationSchema>;

/** One cheap-model pass. Tests inject it. */
export type RunPass = (input: {
  system: string;
  prompt: string;
  pass: "first" | "second";
}) => Promise<TriageClassification>;

export interface ClassifyEmailArgs {
  /** Metering only; never sent to the model. */
  userId?: string;
  /**
   * The only user identity the classifier gets. Rule 16a uses it so a task
   * assigned to a named third party is not minted as the user's todo.
   */
  identity?: { name?: string | null; email?: string | null };
  document: {
    id: string;
    title: string | null;
    content: string;
    authoredAt: Date | null;
    metadata: GmailDocumentMetadata;
  };
  senderContext: SenderContext;
  /** Deterministic pre-model hints, never verdicts (ADR-0051 §4a). */
  observations: Observations;
  runId?: string;
  stepId?: string;
  idempotencyKey?: string;
  /** The eval lowers retries so a provider blip fails over fast and CI stays in budget. */
  maxRetries?: number;
  /** Hedge delay in ms; `0` disables. Unset reads `TRIAGE_CLASSIFY_HEDGE_MS`. */
  hedgeDelayMs?: number;
  /** Tests inject canned passes here. */
  runPass?: RunPass;
}

/** Why the second cheap pass fired (ADR-0051 §4b). */
export interface TriageConflict {
  kind: "under_classification" | "over_classification" | "loop_state";
  /** Goes into the second-pass prompt and the audit. */
  message: string;
}

/** Stored in the `triage.classification` trace. */
export interface ClassifyAudit {
  firstPass: TriageClassification;
  conflict: TriageConflict | null;
  secondPass: TriageClassification | null;
  secondPassFailure: { message: string } | null;
  /** Per-floor audits from {@link applyFloors}, keyed by floor name. */
  floors: FloorAudits;
}

const PASSIVE_CATEGORIES = new Set<TriageCategory>(["fyi", "done", "newsletter", "marketing"]);

const IMPORTANT_CATEGORIES = new Set<TriageCategory>(["urgent", "action_needed"]);

/**
 * Never carry a rail todo. A real obligation here means the category is wrong.
 * `fyi` and `done` stay out: "auto-renews unless you cancel" is a real todo.
 */
const TODO_INELIGIBLE_CATEGORIES = new Set<TriageCategory>(["marketing", "newsletter"]);

/** Count toward a sender's "bulk" share for the over-classification net. */
const BULK_PRIOR_CATEGORIES = new Set<string>(["newsletter", "marketing", "fyi", "done"]);

export const SYSTEM_PROMPT = `You triage emails for a personal assistant. Classify each email into EXACTLY ONE category:

- urgent: action needed within hours, not days. Security alerts where someone reports a risk they OBSERVED about the user's account — an unrecognized/suspicious sign-in ("was this you?"), an unfamiliar device or location, a scanner naming a committed key, a breach naming the user's credential, an account already compromised (rule 15b) — plus billing failure that breaks access today, deadline today, critical CI/CD blocking ship. NOT the account's OWN vendor reporting an event on that account (a login link or code, a password change, a passkey, 2FA, an OAuth grant) — that is fyi (rule 15a), whatever its "if you didn't do this" line says.
- action_needed: the user must take a concrete step that isn't time-critical. Reply, decide, complete a task, rotate a credential, update a card before its actual deadline, verify identity, fix a broken build, respond to a code review. (Vendor self-echo authentication mail is NOT here — the account's own vendor reporting an event on that account, from a sign-in link or one-time code through a password change, passkey, 2FA setting or OAuth grant, is fyi per rule 15a.)
- follow_up: a soft check-in or nudge on a prior thread — "any update on...?", "circling back", "just following up." The sender already knows the user is aware; they're probing for status.
- awaiting_reply: someone is asking the user a direct first question, and the only action is to write back. Pick this when no prior thread exists or the message is a fresh ask. A bulk social-network invitation or connection request is NOT a direct question the user must answer — it is passive social activity (rule 8a → fyi). Once the user has sent a reply that answers the ask, the thread is NO LONGER awaiting_reply — the user owes nothing (rule 18).
- meeting: a LIVE calendar event with a scheduling or attendance action open to the user right now — a direct calendar invite the user is on, a reschedule/time-change to their event, a room/availability negotiation, or a "your meeting starts soon" ping. NOT a recap/notes/minutes/summary of a meeting that ALREADY happened (→ fyi, or done if it explicitly closes a loop), NOT a pre-meeting prep/agenda brief (→ fyi), NOT an event merely ANNOUNCED for the future with no invite and no confirmed date yet (→ fyi), and NOT a collaboration-tool (ClickUp/Linear/Jira/…) comment or notification that only MENTIONS meeting language (route by rule 12e ownership). A calendar meeting the user attends arrives from a real organizer or as a calendar invite, never as a task-tracker/product-notification relay. The words "meet"/"meeting"/"offsite"/"standup" are never enough on their own (rule 7).
- fyi: passive awareness items. Vendor self-echo authentication mail — the account's own vendor reporting an event on that account: sign-in/magic links, one-time and step-up/sudo login codes, email-address verification, "security verification completed", a password changed or reset, a passkey created, 2FA enabled or disabled, an OAuth application added, a recovery address or login method updated (rule 15a), resolved-incident status posts, a third-party vendor's own status/incident post for a service the user only consumes (rule 12f), product release notes without action, social activity digests, social-network connection/invitation requests ("X wants to connect", "I want to connect") and network-growth / profile-activity nudges ("people you may know", "you appeared in N searches", "N people viewed your profile") (rule 8a), "we updated our terms" notices, GitHub notifications that don't require review, legal/investor/shareholder notices with no user action.
- done: explicit closure or completion notice — the user's underlying request/loop is RESOLVED. Order shipped, payment received, deploy succeeded, ticket resolved, "your request has been processed." A task/ticket being CREATED, FILED, OPENED, logged, or "added to the backlog" is the START of work, NOT a closure — never \`done\`, even when an automation reports "Done" about having created it ("Brain: Done. Created [task] in the backlog" = the bot finished FILING the task, the user's request is now OPEN, not resolved). Route task creation by ownership (rule 12e), never to \`done\`. Also \`done\` when the user has sent the latest reply and owes nothing further on the thread — the user's side of the loop is closed, and waiting on the counterparty's response is not a user action (rule 18).
- payment: invoices, receipts that need attention, payment failures, billing notices, refunds, statements.
- newsletter: subscription content the user opted into — weekly digests, Substack posts, professional newsletters, automated content publication.
- marketing: promotional / sales blasts. "20% off this weekend", product launches, public brand events/webinars/keynotes, cold outbound sales, growth-team nurture sequences.

How to use the Observations block:
- The observations are DETERMINISTIC CONTEXT — hints to focus your attention, never verdicts. You still decide the category from the email itself.
- Sender prior is this sender's past category histogram. A 99%-newsletter sender can still send one genuinely urgent message — trust the message over the prior when they disagree. The prior breaks routine ties, it does not override a clear signal.
- Account persona (work/personal) frames what "urgent"/"action_needed" mean for this account.
- Thread state ("you last replied on <date>") and the recent-thread-messages excerpts are context for follow_up vs awaiting_reply vs done — not a deterministic mapping. You classify the WHOLE THREAD and a new message OVERWRITES the thread's single tag, so read the recent messages: if an earlier one carries a live, unanswered ask or assignment to the user, a trailing low-signal line (a bot confirming it filed a task, an acknowledgement, a reaction) must NOT bury it.
- Known contact = the sender is in the user's contacts. A direct ask from a known contact is more likely a real awaiting_reply/action_needed.
- Sender relationship (when present) describes the user's correspondence history WITH this sender: significance (strong/moderate/weak, or \`unscored\` when there IS history but it has not been scored yet — then judge from reciprocity, do NOT treat \`unscored\` as cold), reciprocity (two-way / you reached out / one-way inbound — the user never replied), same-org, and the user's own role. \`no prior contact on record\` means a cold sender with NO history. This is the ONLY way to judge whether a real PERSON is waiting on the user (todo rubric 16b): a weak / one-way / no-prior-contact sender is a cold contact, NOT a real stakeholder, however the email is phrased; a two-way relationship (even \`unscored\`) is a real one. Never infer a relationship beyond what this line states. It does NOT change the category — a cold ask is still an honest awaiting_reply; it only gates the todo.
- Sender kind (when present) is an active user-model projection's confident non-person classification for the sender address: \`group\` means a distribution list/shared mailbox; \`service\` means automated or product-originated mail. Absence of this line means no active/confident projection opinion. When present, do NOT treat the address as a known person or infer a personal relationship from display name alone.
- Gmail signals (categories, IMPORTANT, STARRED) are Gmail's own priors — lean on them when they align.
- Gmail's spam/trash filing is a THIRD PARTY'S VERDICT, not a hint and not a fact: \`spam=true\` means Gmail itself judged the mail unsolicited (rule 20). A spam-filed message is never 'awaiting_reply' and never 'follow_up', however direct its phrasing. It can still be 'urgent'/'action_needed', but only under rule 20's exception — an obligation the user already owns. \`trash=true\` means the user already deleted it — same read, weaker signal.
- Content flags are cheap regex tells: unsubscribe → newsletter/marketing; currency → payment; security → look harder at severity; calendar → meeting; investorNotice → rule 9; publicEvent → rule 8. They are signals to weigh, not commands.

Rules:
1. Pick exactly one category — the dominant one if multiple apply.
2. Time-pressure: prefer 'urgent' over 'action_needed' when consequence-of-delay is hours-not-days (account compromise, security breach, billing failure that breaks access today). A login link or code merely expiring is NOT such a consequence — the user just requests a fresh one.
3. Reply-shape: prefer 'awaiting_reply' over 'action_needed' when the action IS the reply.
4. Reply-shape (continued): prefer 'follow_up' over 'awaiting_reply' when the sender is nudging on an existing thread, not opening a new ask. "Any update?" / "Just circling back" → follow_up.
5. Closure: prefer 'done' over 'fyi' when the message explicitly marks something as finished/shipped/resolved/succeeded. 'fyi' is for informational items that don't close a loop. Closure means the USER'S underlying request/loop is resolved — NOT that an intermediate actor reported finishing a sub-step. Creating, filing, or opening a task/ticket (even one phrased "Done. Created …") OPENS a loop; it is never closure.
6. Promo split: prefer 'marketing' over 'newsletter' for unsolicited promotional blasts, sales pitches, cold outbound, public product launches, brand events, webinars, and keynotes. 'newsletter' is for subscribed editorial/digest content the user opted into.
7. Meeting gate: choose 'meeting' only when the user is a participant (or likely participant) in a LIVE personal/work calendar-style meeting AND there is a concrete scheduling/attendance action for them — an invite to accept, a time to confirm, availability to answer, or an imminent join. The words "meeting", "event", "offsite", "standup", "conference", "webinar", "keynote", "AGM", or "annual general meeting" are NOT enough by themselves. A meeting that ALREADY happened (its notes/recap/minutes/summary), a prep/agenda brief for a meeting, and an event merely ANNOUNCED for the future with no invite or set date are NOT 'meeting' → they are 'fyi' (a recap that explicitly closes a loop may be 'done'). A calendar meeting the user attends arrives from a real organizer or a calendar invite, not as a task-tracker/product-notification relay.
8. Bulk/public event rule: public events, brand announcements, product launches, webinars, conferences, keynotes, and "save the date" blasts are marketing/newsletter/fyi, not meeting, unless the email is a direct calendar invite or scheduling thread for the user. (The publicEvent content flag marks this language.)
    8a. Social-network activity rule: connection / invitation requests ("X wants to connect", "I want to connect", "would like to join your network"), network-growth nudges ("people you may know", "add X to your network"), and profile-activity notifications ("you appeared in N searches", "N people viewed your profile", "your post got N reactions") relayed by a social platform (LinkedIn, X, Instagram, etc.) are passive social activity → 'fyi'. They are NOT 'awaiting_reply'/'action_needed'/'urgent': accepting or ignoring an invitation is the SENDER'S want, not a question the user must answer or a task the user owns (rule 16a-i no_obligation), however senior the requester's stated title. This holds ESPECIALLY for reminder/nudge copies — "still waiting for your response", "is waiting for your response", "you haven't responded", "reminder: X invited you" — which restate the same passive invitation in reply-shaped words. The reminder wording is the PLATFORM's engagement copy, not a new ask from the person named inside; judge by the SENDER (the platform envelope relaying it — SenderContext.effectiveAuthor='service'), not by the literal "waiting for your response" phrase, which never overrides this rule or rules 3/4. EXCEPTION: an actual personal message a real correspondent sent the user THROUGH the platform — where the body carries a genuine ask, not a templated invite — is judged on its content (awaiting_reply/follow_up), gated as always by the Sender relationship observation; a digest relaying a cold/unknown sender's message stays 'fyi'.
9. Investor/legal notice rule: stock-market, shareholder, AGM, proxy/e-voting, annual report, exchange filing, and registrar/depository notices are usually 'fyi'. Use 'action_needed' only when the email asks the user to vote, register, submit a form, make a decision, or meet a concrete deadline. Do not use 'meeting' for a corporate AGM notice just because the notice says "meeting". (The investorNotice content flag marks this language.) More broadly — manufactured or ceremonial urgency (engagement/gamification nudges, "save the date" galas, AGMs) is 'fyi' (or 'marketing') unless it imposes a concrete action + deadline on the user; never 'meeting'/'urgent' on ceremony or a manufactured stake alone.
10. 'meeting' takes precedence over 'action_needed' / 'awaiting_reply' only after the Meeting gate is satisfied.
11. 'payment' takes precedence over 'fyi' / 'done' for any financial transaction notice.
    11a. Owed vs upsell — the discriminator is whether MONEY IS OWED, not whether money is mentioned. Mail that pressures the user to START or EXPAND paid usage — "upgrade your plan", "you've hit your free/trial quota", "trial ending", "unlock more", "running low on credits", "add a seat", "continue receiving X — upgrade" — is OPTIONAL conversion pressure the vendor MANUFACTURES; nothing is owed → 'marketing' (a plain neutral usage/quota notice with no pitch → 'fyi'), NEVER 'payment'/'action_needed'/'urgent', however the quota cap or "to continue" framing is phrased. Money is OWED only on an EXISTING paid relationship — "payment failed", "card declined", "invoice due", "subscription past due", "your card will be charged $X on <date>" — which is 'payment' (rule 11), and 'urgent'/'action_needed' when access breaks. A freemium product hitting its free ceiling (Greptile/Vercel/Linear "upgrade to keep using it") is upsell, not a bill — this holds whether the sender is the vendor directly or a '[bot]' relay (rule 12a still applies). A manufactured DEADLINE on an upsell — "trial ends tomorrow", "capped — act by <date>", "tracking ends soon", "upgrade before you lose the free tier" — does NOT promote it to 'urgent' or 'payment': the deadline is the vendor's CONVERSION lever (manufactured scarcity, rule 16b), not a consequence-of-delay on a commitment the user made. Losing a FREE tier the user never paid for is not the access-loss rule 2 means; stay 'marketing'/'fyi' however near the date.
12. Automated/service mail:
    12a. Bot review comments — any SenderContext.effectiveAuthor='bot' (a GitHub '[bot]' account such as greptile-apps[bot], coderabbit, copilot-review, github-actions, dependabot, renovate, or any other) — are advisory review noise by default → 'fyi', even when they contain suggested fixes or CVE identifiers. Do not gate on a specific bot name.
    12b. Escalate a bot review comment to 'action_needed' or 'urgent' only when the body itself shows severe impact: exposed secret/token/key, auth bypass, data loss, production outage, blocked deploy, or a same-day security/account deadline.
    12c. Severity-suspect bot alerts where botSlug is sentry, stripe-billing, google-security, vercel, or datadog should be classified from body content alone: 'urgent' if same-day actionable, 'action_needed' if remediation is needed but not immediate, otherwise 'fyi'/'done'. PRECEDENCE — rule 15 wins here. An AUTHENTICATION event the account's own vendor reports about that same account (a sign-in or magic link, a one-time or step-up code, email verification, a password/passkey/2FA/OAuth/recovery-address change) is decided by rule 15, never by this rule, whatever the botSlug says. So 15a → 'fyi' when the vendor asserts no observation about WHO acted, and 15b → the demand lane when the asserter names something it claims to have SEEN. The google-security slug is the standing collision: 'accounts.google.com' carries Google's own 'your password was changed' echo (15a, 'fyi') and its 'we detected a new sign-in from an unrecognized device' alert (15b, 'urgent') under one sender. Read the asserter, not the slug and not the same-day wording.
    12d. Unknown service envelopes classify from body content alone.
    12e. Activity-feed notifications from collaboration tools — task/issue trackers (ClickUp, Linear, Asana, Jira, Trello, Monday, Notion, GitHub Issues), doc/design comment threads (Google Docs/Drive, Figma, Confluence), and support/CRM/chat notifications (Zendesk, Intercom, Slack/Discord mention forwards) — separate the item title from the activity. The item title identifies WHAT the notification is about; it does not prove user ownership. The activity body AND recent thread context identify WHO owns the next action. Apply this compact matrix:
      - Activity or status change with no ask owned by the user → 'fyi'.
      - Activity assigns or @-mentions the user with a concrete ask → 'action_needed'; a reply-only ask → 'awaiting_reply'.
      - Activity explicitly resolves the underlying work → 'done'.
      - Activity creates/files/opens an item, including "Done. Created [task]" → opens work, NEVER 'done'. With no user-owned ask in the thread → 'fyi'. With an earlier unanswered assignment/ask to the user → keep 'action_needed'/'awaiting_reply'.
    Use the "You (the user being triaged)" block to decide ownership. Inside a product-team task comment, "the user" or "the customer" can mean the product's END USER, not the email recipient.
    12f. Ownership of the failing system — a third-party vendor's own SERVICE-STATUS / incident notification about THE VENDOR'S systems (status-page posts, "Incident: elevated error rates", "degraded performance", "we've suspended access to X", "scheduled maintenance") for a service the user merely CONSUMES is informational: the user cannot act on the outage, they wait it out → 'fyi' while ongoing, 'done' on an explicit "resolved" post — NEVER 'urgent'/'action_needed'. The vendor's "production issue" is not the USER'S production; do not conflate them. The ONLY exception is a body that imposes a concrete action on the user with a consequence (migrate off a deprecated API by a date, rotate a key the vendor exposed) → then judge that action normally. This is DISTINCT from an alert on the user's OWN / their org's infrastructure (their Sentry project, their CloudWatch alarm, their app's build) — that is judged on real impact per 12c. The discriminator is WHOSE system is failing, not the word "incident".
13. Confidence:
    - 0.9+: unambiguous (newsletter from a clearly subscribed sender, payment receipt with amount, secret-scanning alert from GitHub).
    - 0.7-0.9: clear category but with some overlap.
    - 0.5-0.7: educated guess; pick the best fit but flag uncertainty.
    - Below 0.5: only when no category fits well; still pick the closest one. Low scores get surfaced to the user as "alfred wasn't sure."
14. Rationale: 1-2 sentences grounded in concrete cues: cite subject/body phrasing and any decisive observation you used (sender relationship, recent-thread message, sender prior, or content flag). Do not merely restate the rule. Never invent contact history, ownership, or relationship strength: do not call a sender known/strong/two-way/cold unless the Observations block says so. If the sender relationship affects the todo decision, name the exact observation ("no prior contact", "weak one-way", "strong two-way", etc.).
15. Authentication mail — the test is NOT what the body says. It is WHO asserts that something went wrong.
    15a. Vendor self-echo — ZERO signal → fyi. The account's own vendor reports an event on that account that the USER COULD HAVE PERFORMED: a sign-in / magic link, a one-time or step-up / sudo / re-authentication code ("Sudo email verification code", "your verification code is 123456"), email-address verification, "security verification completed", a password changed or reset, a passkey created, two-factor enabled or disabled, an OAuth application added, a recovery email/phone updated, a login method added or changed. Its "if you didn't do this, act immediately" line is BOILERPLATE: it appears identically on a legitimate echo and on a phish, so it carries no information and NEVER escalates a category on its own. Default to the user having done it → fyi, not action_needed and not urgent, and no rail todo (rule 16c). The mailbox showing a matching request moments earlier only confirms what is already the default.
    15b. Observed-anomaly evidence — REAL signal → the demand lane stays open, usually urgent. Someone reports a risk they claim to have OBSERVED about WHO acted, not merely that the event happened: a risk engine naming an unrecognized device, an unfamiliar location or impossible travel ("we detected a new sign-in from a device you don't usually use", "suspicious sign-in — was this you?", "critical security alert"), a secret scanner naming a key committed to a repository, a breach-notification service naming the user's credential in a dump, or a statement that the account is ALREADY compromised. The asserter holds information the user does not. Judge the asserter and what they claim to have SEEN — never the adjectives, and never the urgency of the phrasing.
    15c. The reasoning behind 15a, so you do not re-open it per email: an 'urgent' tag inside the same mailbox it warns about is not a security control. A compromised mailbox compromises the tag with it; an uncompromised mailbox means the mail is almost certainly the echo of the user's own action. Either way 'urgent' buys nothing over 'fyi'.
16. Todo suggestion (rail) — decide, SEPARATELY from the category, whether this email puts a commitment on the USER worth tracking on their todo rail. This is orthogonal to the category: evaluate the WHOLE email — including a secondary or trailing ask — and do NOT bend the category to fit it (a closure email that ends with a real request stays \`done\` AND may still yield a todo). A todo is a MEMORY AID: it earns its place only if the user could plausibly forget or drop it. Most actionable mail does not clear this bar.
    Apply five tests IN ORDER. Stop at the first that fails; report it in \`todoDecision.outcome\`. Only an email that passes all five gets a \`todoSuggestion\`.
    16a. Obligation on me (gate) — is there an action AND does the USER own it? Two ways to fail. (i) No action falls on the user: pure awareness, the sender's job, an invitation/opportunity/optional nicety, or a product nudging engagement → outcome \`no_obligation\`. A social-network connection request (LinkedIn/X/etc. — "wants to connect", "I want to connect", "would like to join your network") is the canonical optional nicety: the sender's want, not your obligation, and any urgency it phrases is THEIRS → \`no_obligation\` — regardless of the requester's stated title or seniority. A cold "Founder & CEO wants to connect" is still the sender's want, not the user's obligation; whether a connection or any other cold ask is worth a todo is decided by 16b's person-waiting test (the Sender relationship observation), NOT by the title in the email. Distribution-list/service mail (Sender kind \`group\` or \`service\`) is rarely individually actionable unless the body names, assigns, or directly @-mentions the user; do not mint a todo from a generic blast, shared-inbox update, or service activity feed. (ii) The action is real but the email assigns it to a DIFFERENT person: use the "You (the user being triaged)" block to know who you are, then check the owner — if the body hands the task to someone who is not the user ("Sakshi is running standup", "@alice please review the PR", "Karthik to send the deck"), the obligation is THEIRS, not the user's → outcome \`no_obligation\` (note who owns it). A newsletter or shipped-order notice leaves no ball in the user's court; an FYI that says "auto-renews in 30 days unless you cancel" DOES.
    16b. Significance — a REAL, EXTERNAL stake. The obligation must carry a real stake, one of: a real identifiable person waiting on the user; money owed or at risk; a hard deadline; loss of access; a commitment the user made to a human; OR a real-world consequence to the user judged from the content. That last clause is the ONLY way automated/bot mail earns a todo, and for code/PR/review findings (whether from a bot OR a human reviewer) it turns on LIVENESS — is something ALREADY LIVE at stake? A real stake = the issue affects PRODUCTION or already-merged (\`main\`) code: a secret already committed/exposed, a vulnerability in \`main\`, an outage, a broken or blocked production deploy, a same-day security deadline. NO stake = the issue exists only in the UNMERGED changes under review — nitpicks, style, perf suggestions, even a genuine vulnerability that lives only in the PR's proposed code and is not yet in \`main\`/production. That is pre-merge advisory (review working as intended; nothing live is at risk) → fail. The test is not "is a reviewer waiting" but "is something already live at stake." MECHANICAL RULE: a pull-request review comment — anything of the shape "<reviewer> commented on PR #N", "address the review feedback on PR #N", "apply these suggestions" — is BY DEFINITION about code not yet merged, so it is pre-merge advisory and emits NO todo (outcome \`not_significant\`, note \`advisory:\`), REGARDLESS of how concrete or severe the suggested fixes sound, UNLESS the body explicitly says the problem is already in production / \`main\` or a credential is already exposed. CodeRabbit/Greptile "consider…" comments and CVE-FYIs fail. Stakes a product MANUFACTURES to drive engagement OR conversion — gamification streaks ("play before midnight or lose your streak"), unread/notification counts, "N people viewed your profile", marketing scarcity ("ends tonight"), and upsell/quota pressure ("upgrade your plan", "trial ending", "you've hit your free quota", "upgrade to continue") where nothing is actually owed (rule 11a) — and CEREMONIAL obligations (AGM, "save the date") are NOT real stakes, however urgently phrased → outcome \`not_significant\` (set \`note\` prefix \`manufactured:\` or \`advisory:\`). Real-but-trivial asks also fail: rate-your-driver, surveys, "thoughts sometime?", optional feedback. Judge the INTRINSIC stakes — money owed/at-risk, a hard deadline, lost access, a commitment to a human, code/PR liveness — from the email content; they hold regardless of who sent it. The ONE stake you may NOT take from content alone is "a real identifiable PERSON is waiting on the user": it must be CORROBORATED by the Sender relationship observation. A weak / one-way-inbound / \`no prior contact on record\` sender is a cold contact, NOT a real person waiting — a cold ask ("give me a recommendation", "I want to connect", "can you intro me?", "endorse me") fails here however directly it is phrased and whatever the sender's stated title → outcome \`not_significant\` (note prefix \`cold_sender:\`). A strong / two-way relationship — or a known contact with real history — asking a direct question IS a real person waiting → passes. When NO Sender relationship line is present (a bot/service sender), there is no person waiting: judge only the intrinsic stakes. Never infer a relationship the observation does not state.
    16c. Memorability. Would the user plausibly FORGET or DROP this if it is not tracked — or will they obviously handle it now / does it resolve itself? Vendor self-echo authentication mail (the rule-15a class: sign-in/magic links, one-time codes, email verification, and the account's own vendor confirming a password, passkey, 2FA, OAuth or recovery-address change), expiring codes, "thanks!", anything the user is already mid-flow on → nothing to remember → outcome \`would_not_forget\`. A todo here is noise. A notification from a dedicated task/issue tracker or doc-comment tool the user works in (ClickUp, Linear, Jira, Asana, Notion, Google Docs/Drive/Figma comments) is ALREADY tracked and re-notified by that tool — the user will not forget it because the tool itself keeps and resurfaces it. So EVEN a task assigned to the user or a comment @-mentioning them with a concrete ask → \`would_not_forget\`: a rail todo only duplicates the tracker. (The CATEGORY still reflects the real obligation — an assignment/@-mention is honest \`action_needed\` per rule 12e — but the rail does not repeat what the tracker already holds. The exception is a stake that OUTLIVES the tracker item: an exposed secret to rotate stays a todo.)
    16d. Actionability. Can you write a SPECIFIC, self-contained action from the email alone? A vague ask ("something broke, please fix it" with no what/where, "let's catch up sometime", a problem report missing specifics) → outcome \`too_vague\`. A vague rail item is worse than none.
    16e. Already handled. Does thread state show the user already replied/acted, or the loop is closed with no new ask? → outcome \`already_handled\`.
    16f. All five pass → outcome \`proposed\` and set \`todoSuggestion\`. Write \`name\` the way the USER would jot it on a sticky note to themselves — short, plain, object-first — NOT the way the email phrased it. It is a second-person IMPERATIVE that leads with the real verb and names the object, ideally 3–6 words and HARD-CAPPED at 8: "Reply to Priya about Q3 budget", "Rotate the exposed Redis credential", "Add receipts to 4 Brex expenses", "Pay the Zerodha AMC charge". Strip scaffolding the user already knows from context — drop "request"/"notification"/"connection"/"on <Platform>" filler and the email's formal phrasing: "Reply to Ankur on LinkedIn", NOT "Respond to the LinkedIn connection request from Ankur Singh". Fold a count straight into the name ("Fix 3 blocking issues in PR #78", not name + "three items" in assist). NEVER a bare verb ("Log in", "Reply"), and NEVER a hedge or passive frame ("Review and address…", "Look into…", "Provide info for…", "Address the … on …", "Investigate the …") — name the actual action. \`assist\` is null BY DEFAULT — the \`name\` is the whole todo, and a sentence under it is just more for the user to read. Populate \`assist\` ONLY with a HARD FACT the name structurally cannot carry — a money amount, a hard deadline/date, or a genuine either/or decision — and then ONLY as a TERSE FRAGMENT, never a sentence: "₹88.5 · due Jun 11", "before Jun 30", "renews Jul 1 — keep or cancel". Always write a date as an ABSOLUTE calendar date ("Jun 11", "Jul 1") — NEVER a relative word like "tomorrow", "tonight", "today", or "next Friday". A rail todo persists for days, so "due tomorrow" is a lie the moment it goes stale; resolve any relative phrasing in the email against the email's Date shown above and write the actual date. NO verbs, NO restating the name, NO mechanical step ("click the link", "check the logs", "review the profile", "secure the account") — those are noise and MUST be null. When in doubt, null. Never invent specifics absent from the email.
    16g. ALWAYS emit \`todoDecision\`: { "outcome": <one of the six above>, "note"?: "<≤1 short clause if useful>" }. \`todoSuggestion\` is null unless outcome is \`proposed\`.
17. Thread tag is the LIVE loop, not the last keystroke. The thread carries ONE tag and the newest message rewrites it for the whole thread. Do not let a trailing low-signal message — an automation/bot status line ("Done. Created the task", "moved to In Progress"), an acknowledgement, or a reaction — overwrite an open ask from earlier in the thread. When the recent-thread-messages show the user was assigned a task or asked a direct question that is still unanswered, the thread stays \`action_needed\`/\`awaiting_reply\` even when the latest line is a bot's "done". Judge what the thread still needs FROM THE USER, not the wording of the final line.
18. Your own reply closes the loop (the inverse of rule 17). When the MOST RECENT message in the thread is FROM THE USER — thread state reads "you last replied on <date>" and the recent-thread-messages show the user's send as the latest line — and that reply answers the thread's outstanding ask, the thread no longer needs anything FROM THE USER. It is NOT \`awaiting_reply\`/\`action_needed\`: the user does not owe a reply they have already sent. Route it to \`done\` — the user's side of the loop is closed; waiting on the counterparty to respond is THEIR move, not a user action, so do not re-tag it as a thing the user must do. The recruiter who got a reply, the question the user already answered, the request the user already actioned all land here. EXCEPTION: the user's own latest message itself poses a NEW unanswered question to the counterparty or commits the user to a concrete next step — then classify on that open ask, not on the closed one. Rule 17 keeps a trailing low-signal BOT line from burying an open ask; rule 18 recognizes the user's OWN substantive reply as the line that closes it.
19. Collaboration-tool activity (\`collabActivity\`) — SEPARATELY from the category, for a notification from a task/issue tracker or doc-comment thread (ClickUp, Linear, Jira, Asana, Monday, Trello, Notion, GitHub Issues, Google Docs/Drive or Figma comments, and similar collaboration tools), emit \`collabActivity\` naming WHAT the notification is — the same ownership read rule 12e asks for, surfaced as a field:
    - \`assigned_to_user\`: the body assigns / hands the item to the user.
    - \`mentioned_user\`: the user is @-mentioned with a concrete ask.
    - \`comment_to_user\`: a comment or reply directed AT the user — on the user's own item, or answering/asking the user — that expects a response.
    - \`state_change\`: a status/stage change, move, close, or reopen — nobody is asked to do anything.
    - \`other_activity\`: activity on an item the user only watches or is CC'd on — a third-party comment, a newly created item, someone else's edit — NOT directed at the user.
    - \`digest\`: a periodic activity roundup ("N updates in your workspace this week").
    Emit \`null\` for ANY email that is not a collaboration-tool notification (ordinary person-to-person mail, newsletters, marketing, security/auth, payments, calendar invites, social networks, vendor status pages). This is a FACTUAL read of the notification and is independent of the category — set it even when the category is fyi/done. It does not change your category choice; it records the ownership you already judged.
20. Gmail spam verdict — \`spam=true\` in Observations means Gmail itself filed the message as spam: a THIRD PARTY'S verdict that the mail is unsolicited, so treat it as a strong PRIOR, not as proof. Judge the gist — a promo, a phish, bulk outreach → 'marketing'/'fyi'/'newsletter' — not the literal ask: a spam-filed question is still spam, however direct its phrasing ("Would love your thoughts!", "action required", a question mark). It is NEVER 'awaiting_reply' and NEVER 'follow_up'. Those two lanes claim the SENDER is owed a reply, which is exactly what the spam verdict denies. (A deterministic floor enforces that half; this rule is its prompt half.) EXCEPTION, for 'urgent'/'action_needed' ONLY: keep the demand lane when the body names a concrete obligation the USER ALREADY OWNS and that does not depend on trusting the sender — an application, case or ticket the user opened themselves, a deadline on work the user already agreed to, a credential OF THE USER'S that must be rotated — and name that line in the rationale. A demand that only works if the sender is honest ("click here to secure your account", "verify your billing details or lose access") is phish: stay passive. Gmail's filter is fallible, and burying a real ask the user owns costs more than a dismissible false alarm.
21. Document ask: emit \`documentAsk: null\` unless this inbound message explicitly asks the user to send or create a resume or portfolio. When it does, emit exactly \`{"requestedKind":"resume"}\` or \`{"requestedKind":"portfolio"}\`. Do not infer an ask from an attachment, filename, link, sender, prior thread, or generic career prose, and never claim a file was sent or the request resolved.

Examples (subject → category):
- "Sign in to Anthropic" / "Your login code is 123456" / "Verify your email address" the user just requested → fyi (vendor self-echo auth, expires harmlessly, action is moot by the time it surfaces — rule 15a, NOT action_needed, NOT urgent), and no todo (rule 16c memorability — nothing to remember).
- "[GitHub] Sudo email verification code" the user just triggered → fyi (rule 15a, moot by the time it surfaces), no todo (rule 16c). "Security verification completed" / "Passkey created" / "Two-factor authentication enabled" / "A third-party OAuth application was added to your account" → fyi (rule 15a: the account's own vendor echoing an event the user could have performed), no todo. BOUNDARY: "Your Wellfound password was changed", whose body adds "if you did not make this change, your account may be compromised — contact support immediately" → still fyi, because the vendor asserts no observation, only boilerplate (rule 15a). Contrast "Suspicious sign-in from a new device — was this you?" from the account provider → urgent (rule 15b: an observed anomaly about WHO acted).
- "@alice requested your review on PR #42" from noreply@github.com → action_needed (review owed, not time-critical).
- A recruiter's direct ask the user has ALREADY replied to (thread state shows "you last replied …" and the user's send is the latest message) → done (the user's side of the loop is closed; no longer awaiting_reply — rule 18; waiting on the recruiter to write back is not a user action).
- A \`spam=true\` mail whose ask is an obligation the USER ALREADY OWNS — a case or ticket the user opened themselves, a deadline on work the user already agreed to, a credential of the user's to rotate → action_needed (rule 20's EXCEPTION: the obligation holds whether or not the sender is honest, and Gmail's filter is fallible). Contrast "URGENT: verify your billing details within 24 hours" with \`spam=true\` → fyi (the demand works only if the sender is honest — phish).
- "Arjun Rao wants to connect" / "I want to connect" from invitations@linkedin.com → fyi (social-network invitation, passive social activity — rule 8a; NOT awaiting_reply/action_needed, however senior the title), and no todo (rule 16a-i optional nicety).
- "You appeared in 13 searches this week" from notifications@linkedin.com → fyi (profile-activity nudge — rule 8a).
- "**coderabbitai** commented on this pull request" with normal review suggestions → fyi (bot review, advisory by default).
- "**coderabbitai** commented: API key exposed in this PR" → urgent (secret/security exception).
- "Dependabot alert: CVE-2024-1234 in lodash (moderate)" → fyi (advisory bot, no exposed secret — rule 12a).
- "**greptile-apps[bot]** commented: 99Yash has reached the 50-review trial limit — upgrade your plan to continue" → marketing (rule 11a: upsell, nothing owed; the trial cap is manufactured conversion pressure, NOT a bill — never payment/action_needed). Contrast "Your Greptile subscription payment failed" → payment.
- "Errors spiking in production" from Sentry (the USER'S own project) → urgent/action_needed depending on immediacy and the user's project context.
- "Claude Incident — elevated error rate on Opus 4.8" / "We've suspended access to X" from a vendor's status page → fyi (rule 12f: the VENDOR'S own outage, the user only consumes the service; 'done' once the same thread posts "resolved") — NEVER urgent, however alarming "production issue / elevated error rate" sounds. The discriminator vs the Sentry line above is WHOSE system is failing.
- "See you next week." from Apple / Inside Apple with WWDC or product-event content → marketing (public brand event, not the user's meeting).
- "Join our launch webinar on Thursday" from a vendor → marketing (public event blast, not a personal meeting).
- "Sundram Fasteners Limited — 63rd Annual General Meeting..." from a registrar/depository → fyi (shareholder/legal notice, not the user's meeting).
- "Proxy voting closes tomorrow — cast your vote" from a registrar/depository → action_needed (concrete user action/deadline).
- "Meeting notes: Eng standup • …" / "Post Meet Summary" from an automated meeting-assistant → fyi (a recap of a meeting that ALREADY happened — rule 7; nothing to attend or schedule), no todo.
- "Meeting prep: Weekly Sync • …" / an agenda brief from an automated assistant → fyi (a pre-meeting brief, not a calendar action — rule 7).
- A ClickUp/Linear comment "@everyone we'll meet in-person for the offsite in Aug, I'll confirm the dates" → fyi (rule 12e collab-tool relay + rule 7: a future event with no invite or set date; "meet" is not enough), no todo (16a: an @everyone broadcast, the sender owns confirming the dates).

Todo-decision exemplars (each illustrates the ONE rubric test that decides it — note category and todo can disagree):
- Client "Order shipped — also, please send the signed SOW by Friday" → category done, todo "Send the signed SOW to <client> by Friday" (16a+16b+16c all pass; category and todo disagree).
- Vendor FYI "Your plan auto-renews on Jul 1 unless you cancel" → category fyi, todo "Decide whether to cancel <vendor> before the Jul 1 auto-renew" (16a obligation holds on an fyi).
- "something broke on the site, can you look?" with no specifics → category action_needed, no todo (16d actionability: too vague).
- A PR review (bot OR human) asking to add a timeout, optimize an index, fix style, or even patch a vulnerability that exists ONLY in the unmerged PR → category fyi, no todo (16b liveness: pre-merge advisory, nothing in production at stake). BUT a secret already committed/exposed, a vulnerability in \`main\`, or a blocked production deploy → todo (16b: a live consequence).
- A cold ask — "give me a recommendation", "endorse my skills", "can you intro me?" — whose Sender relationship reads \`weak · one-way inbound\` or \`no prior contact on record\` → category awaiting_reply (an honest direct ask), no todo (16b person-waiting: a cold contact is not a real person waiting, note \`cold_sender:\`). The SAME ask from a \`strong · two-way\` contact (or a known contact with real history) → todo (a real person is waiting).`;

function renderThreadObservation(obs: Observations): string[] {
  const lines: string[] = [];
  const t = obs.thread;

  if (t.messageCount > 0) {
    const replied = t.lastUserReplyAt
      ? `you last replied ${t.lastUserReplyAt.toISOString()}`
      : "you have not replied";

    lines.push(
      `Thread: ${t.messageCount} prior message(s); ${replied}; newest is ${t.newestDirection ?? "unknown"}`,
    );

    // Lets a trailing low-signal message see an earlier open ask in the thread.
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

  return lines;
}

/** Rendered beside a matched instruction, never in SYSTEM_PROMPT (see `renderObservations`). */
const STANDING_INSTRUCTION_HANDLING_RULE =
  "How to weigh that line, for THIS SENDER ONLY: treat it as a prior over this sender's prior, the Gmail signals, and urgency cues in the body, because each of those is Alfred's inference and this line is the user's own words. It is still a prior, not a command: prefer 'fyi' for this sender's routine notices even when they carry urgency cues, while still allowing a demand lane for a genuinely urgent item judged from the body. Apply none of this to any other sender.";

/**
 * Prompt budget for the cold-start prior, in characters. Capped here at the
 * render site because `UserContextLine` is a public interface any caller can build.
 * A clipped line costs about 270 tokens; no prior costs 0.
 */
const USER_CONTEXT_LINE_MAX_CHARS = 600;

/**
 * Clip the prior and append `…[+N chars]` so the model never reads it as whole (ADR-0070).
 * {@link sanitizeErrorMessage} does the cut because a bare `slice` can split a surrogate pair.
 * N comes from the kept string, and the notice sits outside the cap.
 */
function clipUserContextLine(text: string): string {
  const bounded = sanitizeErrorMessage(text, USER_CONTEXT_LINE_MAX_CHARS);

  if (text.length <= USER_CONTEXT_LINE_MAX_CHARS) return bounded;

  const kept = bounded.trimEnd();

  return `${kept}…[+${text.length - kept.length} chars]`;
}

/**
 * Demotes the cold-start prior. It comes from Alfred's web research, not the user's
 * mail, so it is the weakest signal and may describe a different person.
 */
const USER_CONTEXT_HANDLING_RULE =
  "How to weigh that line: it is Alfred's own web research about the user, not the user's words and not this email, so it is the WEAKEST signal in this block. Use it only to judge whether this email touches the user's employer, studies, projects or public profiles. It never decides a category on its own, it never outranks the email body, and it never outranks the standing instruction above.";

function renderObservations(obs: Observations): string {
  const lines: string[] = ["=== Observations (deterministic context — hints, not verdicts) ==="];

  // First: the user's own words outrank every inferred signal. Render `phrasing`,
  // not `directive`, which is model-composed.
  // The handling rule sits here, not in SYSTEM_PROMPT: there it flipped unrelated
  // eval rows (`clickup-bot-done-buries-live` went action_needed → fyi).
  if (obs.standingInstruction) {
    // Legacy rows can carry a newline that would forge a `===` section.
    const phrasing = obs.standingInstruction.phrasing.replace(/[\r\n]+/g, " ").trim();
    lines.push(
      `User's standing instruction for THIS SENDER, in the user's own words: ${phrasing}`,
      `  ${STANDING_INSTRUCTION_HANDLING_RULE}`,
    );
  }

  // Below the user's words, above the derived signals.
  // `senderExtractionEvent` mirrors this null check as `userContextPresent`. Change both together.
  if (obs.userContext) {
    lines.push(
      `What Alfred researched about the user (recorded ${obs.userContext.recordedAt.toISOString()}): ${clipUserContextLine(obs.userContext.text)}`,
      `  ${USER_CONTEXT_HANDLING_RULE}`,
    );
  }

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

  if (obs.senderKind) {
    const evidence = obs.senderKind.evidenceCodes.length
      ? `; evidence=${obs.senderKind.evidenceCodes.join(",")}`
      : "";

    lines.push(
      `Sender kind: ${obs.senderKind.kind} (active projection confidence=${obs.senderKind.confidence.toFixed(2)}${evidence})`,
    );
  }

  const g = obs.gmail;
  lines.push(
    `Gmail signals: categories=[${g.categories.join(", ")}]; important=${g.important}; starred=${g.starred}; inbox=${g.inInbox}; spam=${g.spam}; trash=${g.trash}`,
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
  const { from, to, cc } = meta;

  lines.push("=== SenderContext ===");
  lines.push(JSON.stringify(args.senderContext));
  lines.push("");

  // For the ownership gate (rule 16a). Absent, the model guesses.
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

  if (args.document.authoredAt) lines.push(`Date: ${args.document.authoredAt.toISOString()}`);
  lines.push("");

  lines.push("=== Subject — context, not proof of user ownership ===");
  lines.push(args.document.title?.trim() || "(no subject)");
  lines.push("");
  lines.push("=== Body ===");

  const body = extractGmailDocumentBody(args.document.content, {
    from,
    to,
    cc,
    subject: args.document.title,
  });

  const content =
    body.length > TRIAGE_BODY_MAX_CHARS
      ? body.slice(0, TRIAGE_BODY_MAX_CHARS) + "\n[…truncated]"
      : body;

  lines.push(content);

  lines.push("");
  lines.push("=== Earlier thread context — use this to decide loop state and ownership ===");
  lines.push(...renderThreadObservation(args.observations));
  lines.push(
    "Final loop-state check: if the earlier context shows an unanswered user-owned assignment or ask, you MUST keep action_needed/awaiting_reply. A passive current message cannot demote that open loop.",
  );

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

interface BulkProfile {
  total: number;
  bulkShare: number;
}

function priorBulkProfile(categoryCounts: Record<string, number>): BulkProfile {
  let total = 0;
  let bulk = 0;

  for (const [cat, n] of Object.entries(categoryCounts)) {
    total += n;

    if (BULK_PRIOR_CATEGORIES.has(cat)) bulk += n;
  }

  return { total, bulkShare: total > 0 ? bulk / total : 0 };
}

interface ActionShare {
  total: number;
  actionShare: number;
}

function priorActionShare(categoryCounts: Record<string, number>): ActionShare {
  let total = 0;
  let action = 0;

  for (const [cat, n] of Object.entries(categoryCounts)) {
    total += n;

    if (cat === "action_needed") action += n;
  }

  return { total, actionShare: total > 0 ? action / total : 0 };
}

/** A received message may be newer than the user's last reply. Not proof of an ask. */
function hasPossiblyUnansweredReceivedContext(observations: Observations): boolean {
  const lastReply = observations.thread.lastUserReplyAt;

  return observations.thread.recentMessages.some(
    (message) =>
      message.direction === "received" &&
      (lastReply == null || message.authoredAt == null || message.authoredAt > lastReply),
  );
}

/**
 * Find a conflict between the first answer and typed evidence that earns one
 * second pass (ADR-0051 §4b). `floorMatches` skips a re-ask the override floor makes moot.
 */
export function detectConflict(
  classification: TriageClassification,
  observations: Observations,
  floorMatches: boolean,
  senderContext?: Pick<SenderContext, "effectiveAuthor">,
): TriageConflict | null {
  // Security vocabulary but a passive category, and the floor will not fix it.
  if (
    observations.content.hasSecurityKeyword &&
    PASSIVE_CATEGORIES.has(classification.category) &&
    !floorMatches
  ) {
    return {
      kind: "under_classification",
      message: `Security or authentication vocabulary was detected in the body, but you classified this as "${classification.category}" (a passive category). Re-check WHO asserts that something went wrong (rule 15). If the only asserter is the account's own vendor reporting an event on that account — including any "if you didn't do this" boilerplate, however alarming — the passive category is CORRECT and you should keep it. Escalate only when a party reports a risk they claim to have OBSERVED (an unrecognized device or location, a scanner naming a committed key, a breach naming the user's credential) or when the body carries a concrete non-auth obligation you overlooked.`,
    };
  }

  // A passive collab event, but an earlier received message may hold an open ask.
  // The second pass may keep the passive answer.
  const collabActivity = classification.collabActivity ?? null;

  if (
    PASSIVE_CATEGORIES.has(classification.category) &&
    collabActivity != null &&
    isPassiveCollabActivity(collabActivity) &&
    hasPossiblyUnansweredReceivedContext(observations)
  ) {
    return {
      kind: "loop_state",
      message:
        `You classified the current collaboration event as passive ${classification.category}/${collabActivity}, ` +
        "but an earlier received thread message may be newer than the user's last reply. Re-read the earlier message for an assignment or direct ask owned by the user. Keep the passive category only when that context contains no unanswered user-owned work; otherwise keep the open loop action_needed/awaiting_reply.",
    };
  }

  // Net A: an important category from a mostly-bulk sender.
  // Gate on `!floorMatches`, not `!hasSecurityKeyword`: a bulk mail that only
  // mentions security is the false urgent this net must re-ask.
  if (
    IMPORTANT_CATEGORIES.has(classification.category) &&
    !floorMatches &&
    !observations.gmail.important
  ) {
    const { total, bulkShare } = priorBulkProfile(observations.senderPrior.categoryCounts);

    if (total >= TRIAGE_STRONG_BULK_MIN_TOTAL && bulkShare >= TRIAGE_STRONG_BULK_MIN_SHARE) {
      return {
        kind: "over_classification",
        message: `You classified this as "${classification.category}", but this sender is historically bulk mail (${Math.round(bulkShare * 100)}% of ${total} prior messages were newsletter/marketing/fyi/done), Gmail did not mark it IMPORTANT, and no exposed-secret signal fired. Promotional-urgency language ("act now", "last chance"), an educational or security-topic MENTION, or a third-party vendor's own status/incident post is not a real deadline or YOUR incident — confirm this is genuinely actionable BY the user (rules 12f, 16b).`,
      };
    }
  }

  // Net B (#351): a service sender whose prior is mostly `action_needed` feeds
  // its own history back as proof. Re-ask once; a real assignment keeps it.
  // Net A misses this because that prior is not "bulk".
  if (
    classification.category === "action_needed" &&
    !floorMatches &&
    !observations.gmail.important
  ) {
    const priorKey = observations.senderPrior.key;

    const isService =
      senderContext?.effectiveAuthor === "service" ||
      observations.senderKind?.kind === "service" ||
      (priorKey?.startsWith("service:") ?? false);

    const { total, actionShare } = priorActionShare(observations.senderPrior.categoryCounts);

    if (
      isService &&
      total >= TRIAGE_SERVICE_ACTION_LOOP_MIN_TOTAL &&
      actionShare >= TRIAGE_SERVICE_ACTION_LOOP_MIN_SHARE
    ) {
      return {
        kind: "over_classification",
        message: `You classified this as "action_needed", but this is an automated collaboration/task-tracker service and its prior is ${Math.round(actionShare * 100)}% action_needed across ${total} messages — a self-reinforcing histogram, not evidence. Re-read the BODY per rule 12e: action_needed requires the item to be ASSIGNED to the user, the user @-mentioned with a concrete ask, or a reply owed BY the user. A third-party comment, a status change ("set status to X", "moved to Done", "re-opened QA"), or activity on an item the user merely watches is 'fyi'. OWNERSHIP CARVE-OUT: a build, test, or CI result on the USER'S OWN repository or project — the branch or commit they pushed, their own deploy, their own app — is owned BY them by construction and needs no assignment line; keep action_needed, because "fix a broken build" is named in the action_needed definition and rule 12f carves the user's own infrastructure out of the passive-vendor rule. For that case the histogram is worse than useless: it counts the user's OWN past CI failures, so a high action_needed share is exactly what a self-authored build sender always looks like. If the body genuinely assigns it to the user, KEEP action_needed and name the line that shows it.`,
      };
    }
  }

  // Net C: `awaiting_reply` on a service envelope, usually reply-worded platform
  // copy ("still waiting for your response"). Only for senders the projection
  // never scored; the sender-kind floor covers the rest. An ownership
  // `collabActivity` vetoes the re-ask, as it does on that floor.
  if (
    classification.category === "awaiting_reply" &&
    !floorMatches &&
    !observations.gmail.important &&
    observations.senderKind == null
  ) {
    const isServiceEnvelope = senderContext?.effectiveAuthor === "service";
    const collab = classification.collabActivity ?? null;
    const ownershipVeto = collab != null && isOwnershipCollabActivity(collab);

    if (isServiceEnvelope && !ownershipVeto) {
      return {
        kind: "over_classification",
        message: `You classified this as "awaiting_reply", but the sender is a deterministic SERVICE envelope (SenderContext.effectiveAuthor='service') — a platform relay, notification address, or automated sender, not a person waiting on the user. Reply-shaped platform copy ("still waiting for your response", "we'd love your thoughts", "action required") is engagement boilerplate, not a direct question owed a reply. Re-read per rules 8a/12: a social-network invitation/reminder relayed by the platform is 'fyi' even when it says someone is "waiting"; automated/service mail is judged from body content alone. KEEP awaiting_reply ONLY when the body carries a genuine personal ask from a real correspondent (the rule-8a exception) — and name the line that shows it.`,
      };
    }
  }

  return null;
}

/** The cheap model's todo proposal after the gate. */
export type ResolvedTodoSuggestion = { name: string; assist?: string };

// `assist` must be a short amount or date. The model pads it with prose and URLs,
// so the keep/drop is enforced here, not in the prompt.
const ASSIST_URL_RE = /https?:\/\//i;

const ASSIST_AMOUNT_RE =
  /[₹$€£¥]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:usd|eur|gbp|inr|rs\.?|rupees?|dollars?)\b/i;

const ASSIST_DATE_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b/i;

// A todo lives for days, so "tomorrow" goes stale. Resolve against the send day.
const RELATIVE_DAY_OFFSETS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\btomorrow\b/gi, 1],
  [/\byesterday\b/gi, -1],
  [/\b(?:today|tonight)\b/gi, 0],
];

// Relative phrasing with no single day ("next Friday"). An assist with one is dropped.
const RESIDUAL_RELATIVE_RE =
  /\b(?:next|this|last)\s+(?:week|month|year|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\bin\s+\d+\s+(?:day|week|month)s?\b|\b(?:today|tonight|tomorrow|yesterday)\b/i;

/** The send instant plus the user's zone. A UTC reading put "tomorrow" a day off east of UTC. */
export interface AssistDateAnchor {
  sentAt: Date;
  timezone: IanaTimezone;
}

/**
 * Replace relative day words with an absolute date. Offsets apply to the date key,
 * not milliseconds, so DST cannot shift them. No anchor strips the word.
 */
function resolveRelativeDates(text: string, anchor: AssistDateAnchor | null): string {
  const sentDay = anchor ? inZone(anchor.timezone).day(anchor.sentAt) : null;
  let out = text;

  for (const [re, offset] of RELATIVE_DAY_OFFSETS) {
    const replacement = sentDay ? formatDay(addDays(sentDay, offset), "short") : "";
    out = out.replace(re, replacement);
  }

  // Tidy separators/words left dangling by stripped dates ("₹88.5 · due " → "₹88.5").
  let cleaned = collapseWhitespace(out);
  let previous: string;

  do {
    previous = cleaned;
    cleaned = cleaned.replace(/\s*(?:·|,|—|-|\bdue\b|\bby\b)\s*$/gi, "").trim();
  } while (cleaned !== previous);

  return cleaned;
}

/**
 * Keep `assist` only as a short amount or absolute date, never a URL; else `undefined`.
 * `anchor` is required, not optional: a `null` anchor strips every relative date.
 */
export function sanitizeAssist(
  assist: string | null | undefined,
  anchor: AssistDateAnchor | null,
): string | undefined {
  const trimmed = assist?.trim();

  if (!trimmed) return undefined;
  const text = resolveRelativeDates(trimmed, anchor);

  if (!text || text.length > TRIAGE_TODO_ASSIST_MAX_CHARS) return undefined;

  if (ASSIST_URL_RE.test(text)) return undefined;

  if (RESIDUAL_RELATIVE_RE.test(text)) return undefined;

  if (!ASSIST_AMOUNT_RE.test(text) && !ASSIST_DATE_RE.test(text)) return undefined;

  return text;
}

// Hedge titles ("Look into…") that rule 16f bans but the model still emits.
// Only verbs that are never the real action: "review" or "verify" can be, so they stay out.
const TODO_HEDGE_PREFIX_RE =
  /^(?:please\s+)?(?:look into|look at|dig into|take a look at|provide (?:info|information|details)|investigate|view)\b/i;

// Filler left after the verb ("View task Eng…" → "Eng…").
const TODO_HEDGE_FILLER_RE = /^(?:the|a|an|this|that|into|at|on|for|about|tasks?)\s+/i;

/** Strip a hedge prefix from a todo title (rule 16f). Never empties the title. */
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

  // A one-word remainder means the hedge verb carried the meaning.
  if (rest.split(/\s+/).filter(Boolean).length < 2 || rest.length < 4) return trimmed;

  return /^[a-z]/.test(rest) ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest;
}

// Note prefixes of a failing 16b outcome. On a `proposed` decision the model
// contradicts itself; trust the note and mint no todo.
const FAILING_OUTCOME_NOTE_PREFIX_RE = /^\s*(?:cold_sender|manufactured|advisory)\s*:/i;

export function noteMarksFailingOutcome(note: string | null | undefined): boolean {
  return note != null && FAILING_OUTCOME_NOTE_PREFIX_RE.test(note);
}

/**
 * The rail todo to mint from a final classification (ADR-0050), or null.
 * The model's rubric is the judgment; this is a consistency guard.
 */
export function resolveTodoSuggestion(
  classification: TriageClassification,
  anchor: AssistDateAnchor | null,
): ResolvedTodoSuggestion | null {
  const suggestion = classification.todoSuggestion ?? null;

  if (!suggestion) return null;

  if (classification.documentAsk) return null;

  if (classification.todoDecision?.outcome !== "proposed") return null;

  if (noteMarksFailingOutcome(classification.todoDecision?.note)) return null;

  if (TODO_INELIGIBLE_CATEGORIES.has(classification.category)) return null;
  const name = sanitizeTodoName(suggestion.name);
  const assist = sanitizeAssist(suggestion.assist, anchor);

  return assist ? { name, assist } : { name };
}

/** Why an email gets no rail todo even though the model proposed one. */
export type TodoSuppressionReason =
  | "alfred_approval"
  | "pre_merge_advisory"
  | "tracker_owned"
  | "cold_sender"
  | "user_already_replied";

// Tracker notification senders (#353), subdomains included. Fallback for
// `tracker_owned` when the model omits `collabActivity`.
const TASK_TRACKER_SENDER_RE =
  /@(?:[\w.-]*\.)?(?:clickup\.com|linear\.app|atlassian\.net|asana\.com|monday\.com|trello\.com|notion\.so|height\.app|shortcut\.com)\b/i;

// Alfred's own human-in-the-loop approval mail: "[medium] Alfred wants to …".
const ALFRED_APPROVAL_SUBJECT_RE =
  /^\s*\[(?:no_risk|low|medium|high|critical)\]\s+alfred wants to\b/i;

// Lanes whose only stake is "a person is waiting", which a cold contact lacks (rule 16b).
const COLD_SENDER_GATED_CATEGORIES = new Set<TriageCategory>(["awaiting_reply", "follow_up"]);

/**
 * A real stake that keeps a cold sender's todo (rule 16b). Uses the RECALL
 * credential predicate: this only preserves a todo, and a miss buries a breach notice.
 */
function hasIntrinsicStakeSignal(signalText: string): boolean {
  return (
    matchesExposedCredentialClaim(signalText) ||
    matchesCollabIntrinsicStake(signalText) ||
    ASSIST_AMOUNT_RE.test(signalText) ||
    ASSIST_DATE_RE.test(signalText)
  );
}

// Something already live makes a PR thread a real stake (rule 16b), not advisory.
const TODO_LIVENESS_RE =
  /\bproduction\b|\bprod\b|\boutage\b|\bincident\b|\balready merged\b|\bin main\b|\bblocked deploy|\bdeploy(?:ment)? (?:failing|blocked|broken)\b/i;

/**
 * Kill a proposed todo the model should not have proposed (rule 16). Never changes the category.
 * `user_already_replied` is per message on purpose: a whole-thread "newest is mine"
 * flag flips on the next inbound and buries a fresh ask.
 */
export function todoSuppressionReason(email: {
  sender: string | null;
  subject: string | null;
  signalText: string;
  collabActivity?: CollabActivityKind | null;
  category?: TriageCategory | null;
  isColdContact?: boolean;
  /** The user's newest send is newer than this message. */
  userRepliedAfterMessage?: boolean;
}): TodoSuppressionReason | null {
  if (email.userRepliedAfterMessage) return "user_already_replied";

  if (ALFRED_APPROVAL_SUBJECT_RE.test(email.subject ?? "")) return "alfred_approval";

  if (isGithubNotificationSender(email.sender) && matchesPrThread(email.signalText)) {
    const live =
      TODO_LIVENESS_RE.test(email.signalText) || matchesExposedCredentialClaim(email.signalText);

    if (!live) return "pre_merge_advisory";
  }

  // The tracker already reminds the user (rule 16c, #353), even for assigned work.
  // An exposed credential still earns a todo.
  if (
    (email.collabActivity != null || TASK_TRACKER_SENDER_RE.test(email.sender ?? "")) &&
    !matchesExposedCredentialClaim(email.signalText)
  ) {
    return "tracker_owned";
  }

  if (
    email.isColdContact &&
    email.category != null &&
    COLD_SENDER_GATED_CATEGORIES.has(email.category) &&
    !hasIntrinsicStakeSignal(email.signalText)
  ) {
    return "cold_sender";
  }

  return null;
}

/** Lowercased subject + body + snippet for the floor predicates. */
function floorSignalText(document: ClassifyEmailArgs["document"]): string {
  const parts: string[] = [];

  if (document.title) parts.push(document.title);
  parts.push(document.content);
  const { snippet } = document.metadata;

  if (snippet) parts.push(snippet);

  return parts.join("\n").toLowerCase();
}

/** Body + snippet only: task/issue titles are not intrinsic-stake evidence for collab floors. */
function floorBodySignalText(document: ClassifyEmailArgs["document"]): string {
  const parts: string[] = [document.content];
  const { snippet } = document.metadata;

  if (snippet) parts.push(snippet);

  return parts.join("\n").toLowerCase();
}

/**
 * Rubric plus Alfred's own identity from env. Without it, "<our hostname> was
 * granted access" reads as an unknown third party.
 */
function classifySystemPrompt(): string {
  return `${SYSTEM_PROMPT}\n\n${selfIdentityGrounding()}`;
}

/** First pass, a second pass on conflict, then the floors. */
export async function classifyEmail(
  args: ClassifyEmailArgs,
): Promise<{ classification: TriageClassification; model: string; audit: ClassifyAudit }> {
  const useInjected = Boolean(args.runPass);
  const model = useInjected ? null : route("cheap").model();
  const baseModelId = model ? identifyLanguageModel(model).modelId : "injected";
  const runPass: RunPass = args.runPass ?? defaultRunPass(model, args);

  const signalText = floorSignalText(args.document);
  const collabVetoText = floorBodySignalText(args.document);
  const floorMatches = matchesExposedSecret(signalText);

  const firstPass = await runPass({
    system: classifySystemPrompt(),
    prompt: userPrompt(args, null),
    pass: "first",
  });

  const conflict = detectConflict(firstPass, args.observations, floorMatches, args.senderContext);
  let working = firstPass;
  let secondPass: TriageClassification | null = null;
  let secondPassFailure: { message: string } | null = null;

  if (conflict) {
    // A failed second pass keeps the first pass. Rethrowing would fall back to
    // `fyi` and bury a real urgent; escalating would flag every vendor auth echo.
    try {
      secondPass = await runPass({
        system: classifySystemPrompt(),
        prompt: userPrompt(args, conflict),
        pass: "second",
      });
      working = secondPass;
    } catch (err) {
      secondPassFailure = { message: errorMessage(err) };
      secondPass = null;
      working = firstPass;
    }
  }

  const meta = args.document.metadata;
  const { from, to, cc } = meta;

  const floors = applyFloors(working, {
    signalText,
    collabVetoText,
    senderKind: args.observations.senderKind,
    effectiveAuthor: args.senderContext.effectiveAuthor,
    sender: from ?? null,
    subject: args.document.title,
    to: to ?? null,
    cc: cc ?? null,
    accountEmail: args.identity?.email ?? null,
    contentFlags: args.observations.content,
    isSpam: args.observations.gmail.spam,
  });

  const classification = floors.classification;

  // Pass tags, then floor tags in sequence order. Query with `LIKE '%+kindfloor%'`, never equality.
  const model_id = [
    baseModelId,
    ...(secondPass ? ["+2pass"] : []),
    ...(secondPassFailure ? ["+2pass_failed"] : []),
    ...floors.modelIdTags,
  ].join("");

  return {
    classification,
    model: model_id,
    audit: { firstPass, conflict, secondPass, secondPassFailure, floors: floors.audits },
  };
}

/** Process-wide hedge ceiling. Lazy, so importing never runs `serverEnv()`, which can throw. */
let _hedgeBudget: HedgeBudget | undefined;

function classifyHedgeBudget(): HedgeBudget {
  _hedgeBudget ??= createHedgeBudget(hedgeCeilingFor(serverEnv().AGENT_WORKER_CONCURRENCY));

  return _hedgeBudget;
}

/**
 * The request one classify pass sends. `signal` is required: if it does not
 * reach the request, the hedge loser is never cancelled and silently bills twice.
 */
export function classifyCallOptions(input: {
  model: LanguageModel;
  instructions: string;
  prompt: string;
  signal: AbortSignal;
  maxRetries: number | undefined;
}): MeteredGenerateObjectArgs<TriageClassification> {
  return {
    model: input.model,
    instructions: input.instructions,
    prompt: input.prompt,
    schema: triageClassificationSchema,
    temperature: 0,
    maxOutputTokens: TRIAGE_MAX_OUTPUT_TOKENS,
    // A hung call must not hold a worker slot. A total budget across retries,
    // so an expired timeout leaves nothing for `withFallback`.
    timeout: { totalMs: TRIAGE_REQUEST_TIMEOUT_MS },
    // Cancels the losing hedge. `withFallback` does not retry an abort on the fallback.
    abortSignal: input.signal,
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
  };
}

/**
 * The production pass runner, hedged (#436): a slow answer gets a twin call and
 * the first wins. The hedge fires per pass, so a conflict can draw four times;
 * {@link hedgeCeilingFor} caps it.
 */
function defaultRunPass(model: LanguageModel | null, args: ClassifyEmailArgs): RunPass {
  const name = (pass: "first" | "second") =>
    pass === "second" ? "triage.classify.second_pass" : "triage.classify";

  return async ({ system, prompt, pass }) => {
    if (!model) throw new Error("[triage] classifyEmail: no cheap model and no runPass injected");
    const delayMs = args.hedgeDelayMs ?? serverEnv().TRIAGE_CLASSIFY_HEDGE_MS;

    const result = await runHedged({
      delayMs,
      // With hedging off (the eval) there is nothing to budget, so skip `serverEnv()`.
      ...(delayMs > 0 ? { budget: classifyHedgeBudget() } : {}),
      run: ({ attempt, signal }) =>
        meteredGenerateObject<TriageClassification>(
          classifyCallOptions({
            model,
            instructions: system,
            prompt,
            signal,
            maxRetries: args.maxRetries,
          }),
          {
            role: "triage",
            userId: args.userId,
            runId: args.runId,
            stepId: args.stepId,
            // One key per pass and per hedge draw: both draws are billed.
            idempotencyKey: args.idempotencyKey
              ? `${args.idempotencyKey}:${pass}${attempt === 1 ? ":hedge" : ""}`
              : undefined,
            requestMeta: {
              purpose: name(pass),
              documentId: args.document.id,
              // Hedge cost = count of calls with `hedge: true`.
              hedge: attempt === 1,
            },
            name: name(pass),
          },
        ),
    });

    const object = result.output;

    return normalizeClassifierOutput(object);
  };
}

export function normalizeClassifierOutput(object: TriageClassification): TriageClassification {
  return {
    ...object,
    confidence: clamp01(object.confidence),
    // The model may omit the key. Never throw: a first-pass throw buries the real answer as `fyi`.
    collabActivity: object.collabActivity ?? null,
    documentAsk: object.documentAsk ?? null,
  };
}

function errorMessage(err: unknown): string {
  return toMessage(err);
}

/** Failure-path category, so no message is left untriaged. */
export const DEFAULT_TRIAGE_CATEGORY: TriageCategory = "fyi";
