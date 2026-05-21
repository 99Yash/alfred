import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
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
  userId: string;
  document: {
    id: string;
    title: string | null;
    content: string;
    authoredAt: Date | null;
    /** Provider metadata — `from`, `to`, `cc`, `labelIds`, `snippet`. */
    metadata: Record<string, unknown>;
  };
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
- meeting: meeting invites, agenda emails, calendar reminders, room/availability negotiations, "your meeting starts soon" pings.
- fyi: passive awareness items. Resolved-incident status posts, product release notes without action, social activity digests, "we updated our terms" notices, GitHub notifications that don't require review.
- done: explicit closure or completion notice. Order shipped, payment received, deploy succeeded, ticket resolved, "your request has been processed."
- payment: invoices, receipts that need attention, payment failures, billing notices, refunds, statements.
- newsletter: subscription content the user opted into — weekly digests, Substack posts, professional newsletters, automated content publication.
- marketing: promotional / sales blasts. "20% off this weekend", product launches, cold outbound sales, growth-team nurture sequences.

Rules:
1. Pick exactly one category — the dominant one if multiple apply.
2. Time-pressure: prefer 'urgent' over 'action_needed' when consequence-of-delay is hours-not-days (security, account, billing failure, verification).
3. Reply-shape: prefer 'awaiting_reply' over 'action_needed' when the action IS the reply.
4. Reply-shape (continued): prefer 'follow_up' over 'awaiting_reply' when the sender is nudging on an existing thread, not opening a new ask. "Any update?" / "Just circling back" → follow_up.
5. Closure: prefer 'done' over 'fyi' when the message explicitly marks something as finished/shipped/resolved/succeeded. 'fyi' is for informational items that don't close a loop.
6. Promo split: prefer 'marketing' over 'newsletter' for unsolicited promotional blasts, sales pitches, cold outbound. 'newsletter' is for subscribed content the user opted into.
7. 'meeting' takes precedence over 'action_needed' / 'awaiting_reply' when the email is primarily about a meeting.
8. 'payment' takes precedence over 'fyi' / 'done' for any financial transaction notice.
9. Automated alerts that demand a remediation step → 'urgent' if same-day (secret-scanning, sign-in verification, account compromise) else 'action_needed' (CI failure on user's code, code-review request, expiring-credential reminder). NOT 'fyi'.
10. Confidence:
    - 0.9+: unambiguous (newsletter from a clearly subscribed sender, payment receipt with amount, secret-scanning alert from GitHub).
    - 0.7-0.9: clear category but with some overlap.
    - 0.5-0.7: educated guess; pick the best fit but flag uncertainty.
    - Below 0.5: only when no category fits well; still pick the closest one. Low scores get surfaced to the user as "alfred wasn't sure."
11. Rationale: 1-2 sentences citing concrete cues (sender, subject phrasing, body content). Don't restate the rule.

Examples (subject → category):
- "[acme/repo] Redis URI exposed on GitHub" from noreply@github.com → urgent (credential must be rotated today).
- "Sign-in attempt from a new device — was this you?" from security@google.com → urgent (verification required now).
- "@alice requested your review on PR #42" from noreply@github.com → action_needed (review owed, not time-critical).
- "Any update on the proposal?" from a client → follow_up (nudge on existing thread).
- "Quick question about Q3 numbers" from a colleague → awaiting_reply (fresh ask, reply IS the action).
- "Your order has shipped — tracking #..." from amazon.com → done (closure notice).
- "Incident resolved: API latency" from status@vercel.com → done (explicit resolution).
- "We updated our Privacy Policy" from a service → fyi (informational, no closure).
- "Your payment failed — update your card" from billing@stripe.com → payment (rule 8) — bump to urgent if access breaks today.
- "Weekly digest from Substack: 5 stories" → newsletter (subscribed content).
- "20% off everything this weekend only!" from a retailer → marketing (promotional blast).

Output JSON: { "category": "...", "confidence": 0.0-1.0, "rationale": "..." }`;

function userPrompt(args: ClassifyEmailArgs): string {
  const lines: string[] = [];
  const meta = args.document.metadata;
  const from = typeof meta.from === "string" ? meta.from : null;
  const to = typeof meta.to === "string" ? meta.to : null;
  const cc = typeof meta.cc === "string" ? meta.cc : null;
  const labelIds = Array.isArray(meta.labelIds) ? (meta.labelIds as string[]) : [];

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

  // `modelIdsFor` resolves to the model's `modelId` — but `getCheapModel`
  // returns an opaque LanguageModel. Re-derive a stable string for the
  // `email_triage.model` column without leaking an `unknown` upstream.
  const modelId = resolveModelId(model);
  return { classification: result.object, model: modelId };
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
