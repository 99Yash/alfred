import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
import { type SenderContext } from "@alfred/contracts";
import { TRIAGE_CATEGORIES, type TriageCategory } from "@alfred/integrations/google";
import { z } from "zod";

/**
 * Email triage classifier (ADR-0025 #1, amended to 10 buckets).
 *
 * Cheap-tier model (Gemini 2.5 Flash by default) classifies a single email
 * into one of ten categories matching the user's numbered Gmail labels
 * (1: urgent through 10: marketing). Pure function — the workflow owns
 * persistence and Gmail label-write side effects. Output is Zod-validated
 * by the AI SDK so the model can't return shapes outside the taxonomy.
 *
 * The taxonomy widened from 6 → 10 once the user kept the full Dimension
 * label set (see decisions.md ADR-0025 amendment). The four added buckets
 * are narrow seams against existing ones — `urgent` against `action_needed`,
 * `follow_up` against `awaiting_reply`, `done` against `fyi`, `marketing`
 * against `newsletter`. Each pair is disambiguated by an explicit rule
 * in the system prompt so the cheap-tier model can still hit acceptable
 * accuracy on 10 buckets.
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
});
export type TriageClassification = z.infer<typeof triageClassificationSchema>;

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
   * Deterministic parse of the sender/envelope/body actor. The cheap
   * classifier may use this typed context, but must not load broader user
   * profile or memory; bio-aware adjudication belongs to `deepen`.
   */
  senderContext: SenderContext;
  /** Run/step ids forwarded to the metering log + Langfuse trace. */
  runId?: string;
  stepId?: string;
  /** Stable per-call idempotency key — caller derives from `(runId, stepId, doc.id, attempt)`. */
  idempotencyKey?: string;
}

const SYSTEM_PROMPT = `You triage emails for a personal assistant. Classify each email into EXACTLY ONE category:

- urgent: action needed within hours, not days. Security alerts, account compromised, sign-in verification, billing failure that breaks access today, deadline today, critical CI/CD blocking ship.
- action_needed: the user must take a concrete step that isn't time-critical. Reply, decide, complete a task, click a confirm link, rotate a credential, update a card before its actual deadline, verify identity, fix a broken build, respond to a code review.
- follow_up: a soft check-in or nudge on a prior thread — "any update on...?", "circling back", "just following up." The sender already knows the user is aware; they're probing for status.
- awaiting_reply: someone is asking the user a direct first question, and the only action is to write back. Pick this when no prior thread exists or the message is a fresh ask.
- meeting: a meeting the user is expected to attend, prepare for, schedule, reschedule, or answer availability for. Direct calendar invites, agenda/prep emails for the user's meeting, room/availability negotiations, and "your meeting starts soon" pings.
- fyi: passive awareness items. Resolved-incident status posts, product release notes without action, social activity digests, "we updated our terms" notices, GitHub notifications that don't require review, legal/investor/shareholder notices with no user action.
- done: explicit closure or completion notice. Order shipped, payment received, deploy succeeded, ticket resolved, "your request has been processed."
- payment: invoices, receipts that need attention, payment failures, billing notices, refunds, statements.
- newsletter: subscription content the user opted into — weekly digests, Substack posts, professional newsletters, automated content publication.
- marketing: promotional / sales blasts. "20% off this weekend", product launches, public brand events/webinars/keynotes, cold outbound sales, growth-team nurture sequences.

Rules:
1. Pick exactly one category — the dominant one if multiple apply.
2. Time-pressure: prefer 'urgent' over 'action_needed' when consequence-of-delay is hours-not-days (security, account, billing failure, verification).
3. Reply-shape: prefer 'awaiting_reply' over 'action_needed' when the action IS the reply.
4. Reply-shape (continued): prefer 'follow_up' over 'awaiting_reply' when the sender is nudging on an existing thread, not opening a new ask. "Any update?" / "Just circling back" → follow_up.
5. Closure: prefer 'done' over 'fyi' when the message explicitly marks something as finished/shipped/resolved/succeeded. 'fyi' is for informational items that don't close a loop.
6. Promo split: prefer 'marketing' over 'newsletter' for unsolicited promotional blasts, sales pitches, cold outbound, public product launches, brand events, webinars, and keynotes. 'newsletter' is for subscribed editorial/digest content the user opted into.
7. Meeting gate: choose 'meeting' only when the user is a participant or likely participant in a personal/work calendar-style meeting. The words "meeting", "event", "conference", "webinar", "keynote", "AGM", or "annual general meeting" are NOT enough by themselves.
8. Bulk/public event rule: public events, brand announcements, product launches, webinars, conferences, keynotes, and "save the date" blasts are marketing/newsletter/fyi, not meeting, unless the email is a direct calendar invite or scheduling thread for the user.
9. Investor/legal notice rule: stock-market, shareholder, AGM, proxy/e-voting, annual report, exchange filing, and registrar/depository notices are usually 'fyi'. Use 'action_needed' only when the email asks the user to vote, register, submit a form, make a decision, or meet a concrete deadline. Do not use 'meeting' for a corporate AGM notice just because the notice says "meeting".
10. 'meeting' takes precedence over 'action_needed' / 'awaiting_reply' only after the Meeting gate is satisfied.
11. 'payment' takes precedence over 'fyi' / 'done' for any financial transaction notice.
12. Automated/service mail:
    12a. Bot review comments where SenderContext.effectiveAuthor='bot' and botSlug is coderabbit, copilot-review, github-actions, dependabot, or renovate are usually 'fyi'. They are advisory review noise by default, even when they contain suggested fixes.
    12b. Escalate a bot review comment to 'action_needed' or 'urgent' only when the body itself shows severe impact: CVE/vulnerability, exposed secret/token/key, auth bypass, data loss, production outage, blocked deploy, or a same-day security/account deadline.
    12c. Severity-suspect bot alerts where botSlug is sentry, stripe-billing, google-security, vercel, or datadog should be classified from body content alone: 'urgent' if same-day actionable, 'action_needed' if remediation is needed but not immediate, otherwise 'fyi'/'done'.
    12d. Unknown service envelopes classify from body content alone.
13. Confidence:
    - 0.9+: unambiguous (newsletter from a clearly subscribed sender, payment receipt with amount, secret-scanning alert from GitHub).
    - 0.7-0.9: clear category but with some overlap.
    - 0.5-0.7: educated guess; pick the best fit but flag uncertainty.
    - Below 0.5: only when no category fits well; still pick the closest one. Low scores get surfaced to the user as "alfred wasn't sure."
14. Rationale: 1-2 sentences citing concrete cues (sender, subject phrasing, body content). Don't restate the rule.

Examples (subject → category):
- "[acme/repo] Redis URI exposed on GitHub" from noreply@github.com → urgent (credential must be rotated today).
- "Sign-in attempt from a new device — was this you?" from security@google.com → urgent (verification required now).
- "@alice requested your review on PR #42" from noreply@github.com → action_needed (review owed, not time-critical).
- "Any update on the proposal?" from a client → follow_up (nudge on existing thread).
- "Quick question about Q3 numbers" from a colleague → awaiting_reply (fresh ask, reply IS the action).
- "Your order has shipped — tracking #..." from amazon.com → done (closure notice).
- "Incident resolved: API latency" from status@vercel.com → done (explicit resolution).
- "We updated our Privacy Policy" from a service → fyi (informational, no closure).
- "Your payment failed — update your card" from billing@stripe.com → payment (rule 11) — bump to urgent if access breaks today.
- "**coderabbitai** commented on this pull request" with normal review suggestions → fyi (bot review, advisory by default).
- "**coderabbitai** commented: API key exposed in this PR" → urgent (secret/security exception).
- "Errors spiking in production" from Sentry → urgent/action_needed depending on immediacy and user's project context.
- "Weekly digest from Substack: 5 stories" → newsletter (subscribed content).
- "20% off everything this weekend only!" from a retailer → marketing (promotional blast).
- "See you next week." from Apple / Inside Apple with WWDC or product-event content → marketing (public brand event, not the user's meeting).
- "Join our launch webinar on Thursday" from a vendor → marketing (public event blast, not a personal meeting).
- "Sundram Fasteners Limited — 63rd Annual General Meeting..." from a registrar/depository → fyi (shareholder/legal notice, not the user's meeting).
- "Proxy voting closes tomorrow — cast your vote" from a registrar/depository → action_needed (concrete user action/deadline).
- "Design review moved to 3pm — can you attend?" from a colleague/client → meeting (user participation/scheduling).

Output JSON: { "category": "...", "confidence": 0.0-1.0, "rationale": "..." }`;

function userPrompt(args: ClassifyEmailArgs): string {
  const lines: string[] = [];
  const meta = args.document.metadata;
  const from = typeof meta.from === "string" ? meta.from : null;
  const to = typeof meta.to === "string" ? meta.to : null;
  const cc = typeof meta.cc === "string" ? meta.cc : null;
  const labelIds = Array.isArray(meta.labelIds) ? (meta.labelIds as string[]) : [];

  lines.push("=== SenderContext ===");
  lines.push(JSON.stringify(args.senderContext));
  lines.push("");

  if (from) lines.push(`From: ${from}`);
  if (to) lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (args.document.title) lines.push(`Subject: ${args.document.title}`);
  if (args.document.authoredAt) lines.push(`Date: ${args.document.authoredAt.toISOString()}`);
  // Gmail's own labels (CATEGORY_PROMOTIONS, CATEGORY_UPDATES, INBOX, IMPORTANT)
  // are useful priors. Pass them so the model can lean on Gmail's own
  // classification when our fine-grained taxonomy aligns.
  if (labelIds.length) {
    const userVisible = labelIds.filter(
      (l) => l.startsWith("CATEGORY_") || l === "IMPORTANT" || l === "STARRED" || l === "INBOX",
    );
    if (userVisible.length) lines.push(`GmailLabels: ${userVisible.join(", ")}`);
  }
  lines.push("");

  lines.push("=== Body ===");
  // Cap to keep token budget bounded — most emails fit easily; the rare
  // long thread gets truncated, which is fine for triage (the lede usually
  // suffices to classify).
  const content =
    args.document.content.length > 6_000
      ? args.document.content.slice(0, 6_000) + "\n[…truncated]"
      : args.document.content;
  lines.push(content);
  return lines.join("\n");
}

/**
 * Run the cheap-tier model over a single email and return its classification.
 * Output is Zod-validated by the AI SDK; parse failures bubble up so the
 * workflow can decide whether to retry or fall through to a default category.
 */
export async function classifyEmail(
  args: ClassifyEmailArgs,
): Promise<{ classification: TriageClassification; model: string }> {
  const model = getCheapModel();
  const result = await meteredGenerateObject<TriageClassification>(
    {
      model,
      system: SYSTEM_PROMPT,
      prompt: userPrompt(args),
      schema: triageClassificationSchema,
      temperature: 0,
      // Triage answers are tiny — cap hard so a misbehaving model can't
      // burn tokens on a wall-of-text rationale.
      maxOutputTokens: 400,
    },
    {
      role: "triage",
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      idempotencyKey: args.idempotencyKey,
      requestMeta: {
        purpose: "triage.classify",
        documentId: args.document.id,
      },
      name: "triage.classify",
    },
  );

  const classification = applyTriageClassificationGuardrails(
    result.object,
    args.document,
    args.senderContext,
  );

  // `modelIdsFor` resolves to the model's `modelId` — but `getCheapModel`
  // returns an opaque LanguageModel. Re-derive a stable string for the
  // `email_triage.model` column without leaking an `unknown` upstream.
  const modelId = resolveModelId(model);
  return { classification, model: modelId };
}

export function applyTriageClassificationGuardrails(
  classification: TriageClassification,
  document: ClassifyEmailArgs["document"],
  senderContext?: SenderContext,
): TriageClassification {
  if (
    senderContext &&
    isReviewBot(senderContext) &&
    isImportantCategory(classification.category) &&
    !hasSevereReviewBotSignal(signalText(document))
  ) {
    return guardedClassification(
      classification,
      "fyi",
      "recognized code-review bot comment is advisory unless the body shows security, production, or deploy severity",
    );
  }

  if (classification.category !== "meeting") return classification;

  const text = signalText(document);
  if (isInvestorOrShareholderNotice(text)) {
    if (hasDirectInvestorAction(text)) {
      return guardedClassification(
        classification,
        "action_needed",
        "shareholder notice asks for a concrete user action, not a personal meeting",
      );
    }
    return guardedClassification(
      classification,
      "fyi",
      "shareholder/legal notice is informational and not a personal meeting",
    );
  }

  if (isPublicEventBlast(text, document.metadata)) {
    return guardedClassification(
      classification,
      "marketing",
      "public brand event or product announcement is not a personal meeting",
    );
  }

  return classification;
}

function guardedClassification(
  classification: TriageClassification,
  category: TriageCategory,
  reason: string,
): TriageClassification {
  return {
    ...classification,
    category,
    confidence: Math.max(classification.confidence, 0.82),
    rationale: truncateRationale(`${classification.rationale} Guardrail: ${reason}.`),
  };
}

function signalText(document: ClassifyEmailArgs["document"]): string {
  const meta = document.metadata;
  const parts: string[] = [];
  for (const key of ["from", "to", "cc", "snippet"]) {
    const value = meta[key];
    if (typeof value === "string") parts.push(value);
  }
  if (document.title) parts.push(document.title);
  parts.push(document.content);
  const labelIds = Array.isArray(meta.labelIds) ? (meta.labelIds as unknown[]) : [];
  for (const label of labelIds) {
    if (typeof label === "string") parts.push(label);
  }
  return parts.join("\n").toLowerCase();
}

function isInvestorOrShareholderNotice(text: string): boolean {
  return (
    /\bannual general meeting\b|\bagm\b|\bshareholder(s)?\b|\bproxy\b/.test(text) ||
    /\be-?voting\b|\bevoting\b|\bannual report\b/.test(text) ||
    /\bregistrar\b|\bdepository\b|\bnsdl\b|\bcdsl\b/.test(text)
  );
}

function hasDirectInvestorAction(text: string): boolean {
  return (
    /\baction required\b/.test(text) ||
    /\bcast your vote\b|\bplease vote\b|\bplease register\b|\bplease submit\b/.test(text) ||
    /\b(vote|register|submit|complete|approve)\b.{0,80}\b(before|by|deadline|closes|ends|cut-?off|last date)\b/.test(
      text,
    )
  );
}

function isPublicEventBlast(text: string, metadata: Record<string, unknown>): boolean {
  const labelIds = Array.isArray(metadata.labelIds) ? (metadata.labelIds as unknown[]) : [];
  const hasPromoLabel = labelIds.some((label) => label === "CATEGORY_PROMOTIONS");
  const publicEvent =
    /\bwwdc\d*\b|\bkeynote\b|\bwebinar\b|\bconference\b|\bsummit\b/.test(text) ||
    /\bproduct launch\b|\blaunch event\b|\bpublic event\b|\bsave the date\b/.test(text);
  const bulkSignal =
    hasPromoLabel ||
    /\bunsubscribe\b/.test(text) ||
    /\b(news|newsletter|marketing|events)@/.test(text);

  return publicEvent && (bulkSignal || /\bwwdc\d*\b/.test(text));
}

function isReviewBot(senderContext: SenderContext): boolean {
  return (
    senderContext.effectiveAuthor === "bot" &&
    (senderContext.botSlug === "coderabbit" ||
      senderContext.botSlug === "copilot-review" ||
      senderContext.botSlug === "github-actions" ||
      senderContext.botSlug === "dependabot" ||
      senderContext.botSlug === "renovate")
  );
}

function isImportantCategory(category: TriageCategory): boolean {
  return category === "urgent" || category === "action_needed" || category === "awaiting_reply";
}

function hasSevereReviewBotSignal(text: string): boolean {
  return (
    /\bcve-\d{4}-\d+\b|\bvulnerabilit(y|ies)\b|\bsecurity advisory\b|\bexploit\b/.test(text) ||
    // `s` (dotall) so the noun and the exposure verb can sit on separate
    // lines — review-bot bodies wrap, e.g. `**token**\nfound exposed`.
    /\b(secret|credential|api key|token|private key)\b.{0,80}\b(exposed|leak|leaked|committed|found)\b/s.test(
      text,
    ) ||
    /\b(auth bypass|privilege escalation|data loss|production outage|incident)\b/.test(text) ||
    /\b(blocks?|blocked|failing|failed)\b.{0,80}\b(deploy|deployment|release|ship|ci|build)\b/s.test(
      text,
    ) ||
    /\b(action required|deadline|expires|rotate)\b.{0,80}\b(today|now|immediately|within hours)\b/s.test(
      text,
    )
  );
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
