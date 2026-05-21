import { getCheapModel, meteredGenerateObject } from "@alfred/ai";
import { TRIAGE_CATEGORIES, type TriageCategory } from "@alfred/integrations/google";
import { z } from "zod";

/**
 * Email triage classifier (ADR-0025 #1).
 *
 * Cheap-tier model (Gemini 2.5 Flash by default) classifies a single email
 * into one of six categories. Pure function — the workflow owns persistence
 * and Gmail label-write side effects. Output is Zod-validated by the AI SDK
 * so the model can't return shapes outside the taxonomy.
 *
 * Why a six-bucket taxonomy:
 *  - matches the ADR-0025 taxonomy verbatim;
 *  - small enough that the cheap model classifies reliably without examples;
 *  - large enough to drive distinct downstream behavior (drafting on
 *    `awaiting_reply`, briefing inclusion on `action_needed`, suppression
 *    of `newsletter` from briefings).
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

- action_needed: the user must take a concrete step. Reply, decide, complete a task, click a confirm link, rotate a credential, update a card, verify identity, respond to a code review, fix a broken build. Automated senders count — what matters is whether a human action is required.
- awaiting_reply: someone is waiting on the user's reply, and replying IS the action. Pick this when the only action is "write back."
- meeting: meeting invites, agenda emails, calendar reminders, room/availability negotiations, "your meeting starts soon" pings.
- payment: invoices, receipts, payment failures, billing notices, refunds, statements.
- newsletter: marketing emails, promotional digests, automated content blasts, unsubscribe-able subscriptions.
- fyi: passive awareness items the user does NOT need to act on — resolved-incident status posts, product release notes, shipping confirmations without exceptions, "we updated our terms" notices, social activity digests.

Rules:
1. Pick exactly one category — the dominant one if multiple apply.
2. Prefer 'awaiting_reply' over 'action_needed' when the action IS the reply (most common).
3. Prefer 'newsletter' over 'fyi' for any marketing / promotional / mass-distribution email.
4. 'meeting' takes precedence over 'action_needed' when the email is primarily about a meeting (even if it requires a reply).
5. 'payment' takes precedence over 'fyi' for any financial transaction notice.
6. Automated alerts that demand a remediation step → action_needed, NOT fyi. This covers: secret-scanning / credential-exposure alerts, security or breach notices, account-compromise warnings, expiring-credential reminders, CI/CD failures on the user's own code, GitHub review-requests / @mentions / issue assignments, "verify your email" or "confirm your sign-in" prompts. 'fyi' is reserved for notices the user can safely scroll past in the moment.
7. Confidence:
   - 0.9+: the category is unambiguous (newsletter from a clearly promotional sender, payment receipt with amount, secret-scanning alert from GitHub, etc.).
   - 0.7-0.9: clear category but with some overlap.
   - 0.5-0.7: educated guess; pick the best fit but flag uncertainty.
   - Below 0.5: only when no category fits well; still pick the closest one. Low scores get surfaced to the user as "alfred wasn't sure."
8. Rationale: 1-2 sentences citing concrete cues (sender, subject phrasing, body content). Don't restate the rule.

Examples (subject → category):
- "[acme/repo] Redis URI exposed on GitHub" from noreply@github.com → action_needed (credential must be rotated).
- "@alice requested your review on PR #42" from noreply@github.com → action_needed (review owed).
- "Incident resolved: API latency" from status@vercel.com → fyi (resolved; nothing to do).
- "Your payment failed — update your card" from billing@stripe.com → payment (rule 5).
- "Sign-in attempt from a new device — was this you?" from security@google.com → action_needed (verification required).

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
