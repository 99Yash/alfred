/**
 * Canonical triage category list. Lives in `@alfred/contracts` so the
 * web bundle can import it without pulling in the Node-only
 * `@alfred/integrations` package. `@alfred/integrations/google/labels`
 * re-exports `TRIAGE_CATEGORIES` and `TriageCategory` from here and adds
 * the integration-specific Gmail label-name mapping on top — there is
 * only one source of truth.
 */

import { z } from "zod";

export const TRIAGE_CATEGORIES = [
  "urgent",
  "action_needed",
  "follow_up",
  "awaiting_reply",
  "meeting",
  "fyi",
  "done",
  "payment",
  "newsletter",
  "marketing",
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export const TRIAGE_RAIL_SUPPRESSED_CATEGORIES = [
  "newsletter",
  "marketing",
] as const satisfies readonly TriageCategory[];

/** Short display label for the rail chip. */
export const TRIAGE_DISPLAY: Record<TriageCategory, string> = {
  urgent: "Urgent",
  action_needed: "Action",
  follow_up: "Follow-up",
  awaiting_reply: "Awaiting",
  meeting: "Meeting",
  fyi: "FYI",
  done: "Done",
  payment: "Payment",
  newsletter: "Newsletter",
  marketing: "Marketing",
};

export function isTriageCategory(value: unknown): value is TriageCategory {
  return typeof value === "string" && (TRIAGE_CATEGORIES as readonly string[]).includes(value);
}

export const triageCategorySchema = z.enum(TRIAGE_CATEGORIES);

/**
 * Who authored the thread's current triage tag. `auto` = the classifier wrote
 * it (carries confidence/rationale); `user` = the user overrode it via the
 * `triageTagOverride` Replicache mutator (carries `overriddenAt`, no classifier
 * provenance). The discriminant for `SyncedTriageTag` — see rfc-triage-tags.md.
 */
export const TRIAGE_TAG_SOURCES = ["auto", "user"] as const;
export type TriageTagSource = (typeof TRIAGE_TAG_SOURCES)[number];

// ─── Classifier todo proposal (ADR-0050 amendment 2026-06-06) ─────────────
// Lives here (not in `@alfred/api`) so the `email_triage` row can `.$type<>()`
// against it without a db→api dependency. The cheap classifier
// (`@alfred/api` triage/classify) re-uses these schemas as the source of
// truth for its `todoSuggestion` / `todoDecision` fields, and the row persists
// them so a same-run `classify` retry on the reuse path can re-mint the todo.

export const TODO_DECISION_OUTCOMES = [
  "proposed",
  "no_obligation",
  "not_significant",
  "would_not_forget",
  "too_vague",
  "already_handled",
] as const;
export type TodoDecisionOutcome = (typeof TODO_DECISION_OUTCOMES)[number];

/**
 * Real-time todo proposal for the rail. Non-null ONLY when the email cleared
 * every rubric test (rule 16). `assist` is `.nullish()` (not `.optional()`)
 * because flash-lite routinely emits explicit `null`, which a bare `.optional()`
 * would reject.
 */
export const triageTodoSuggestionSchema = z
  .object({
    /** Crisp imperative title for the rail checkbox row. */
    name: z.string().min(1).max(120),
    /** Optional one-liner on how to approach it (or an honest "can't act yet"). */
    assist: z.string().max(280).nullish(),
  })
  .nullable();
export type TriageTodoSuggestion = z.infer<typeof triageTodoSuggestionSchema>;

/**
 * Always-present rubric trace: which test decided the todo call, so a wrong
 * suggestion AND a wrong omission are both debuggable. Invariant:
 * `outcome === 'proposed'` iff the suggestion is non-null.
 */
export const triageTodoDecisionSchema = z.object({
  outcome: z.enum(TODO_DECISION_OUTCOMES),
  note: z.string().max(200).nullish(),
});
export type TriageTodoDecision = z.infer<typeof triageTodoDecisionSchema>;

export const ACCOUNT_PERSONAS = ["work", "personal"] as const;
export type AccountPersona = (typeof ACCOUNT_PERSONAS)[number];
export const accountPersonaSchema = z.enum(ACCOUNT_PERSONAS);

// ─── ADR-0042: SenderContext ──────────────────────────────────────────────

export const SENDER_KIND = ["person", "service", "unknown"] as const;
export type SenderKind = (typeof SENDER_KIND)[number];

export const EFFECTIVE_AUTHOR = ["bot", "person", "service", "unknown"] as const;
export type EffectiveAuthor = (typeof EFFECTIVE_AUTHOR)[number];

/**
 * Bot slug allowlist. Each slug names a recognized automated sender whose
 * envelope or body-actor pattern the `extract-sender-context` step can
 * identify deterministically. Grow this list from observed
 * `triage.sender_extraction` log evidence, never speculation.
 */
export const BOT_SLUGS = [
  "coderabbit",
  "copilot-review",
  "github-actions",
  "dependabot",
  "renovate",
  "vercel",
  "sentry",
  "stripe-billing",
  "google-security",
  "datadog",
] as const;
export type BotSlug = (typeof BOT_SLUGS)[number];

/**
 * Subset of `BOT_SLUGS` whose alerts CAN be same-day urgent. The classifier
 * escalates these to `deepen` even when the cheap prompt would have labelled
 * them `fyi`. Review-comment bots (CodeRabbit, Copilot, GitHub Actions,
 * Dependabot, Renovate) are deliberately excluded — advisory by default,
 * with rule 9a's security-advisory exception catching the rare severe case.
 */
export const SEVERITY_SUSPECT_BOTS: ReadonlySet<BotSlug> = new Set<BotSlug>([
  "sentry",
  "stripe-billing",
  "google-security",
  "vercel",
  "datadog",
]);

export interface SenderContext {
  fromKind: SenderKind;
  bodyActor?: {
    kind: "bot" | "person" | "unknown";
    name: string;
    handle?: string;
  };
  effectiveAuthor: EffectiveAuthor;
  botSlug?: BotSlug;
}

export const senderContextSchema: z.ZodType<SenderContext> = z.object({
  fromKind: z.enum(SENDER_KIND),
  bodyActor: z
    .object({
      kind: z.enum(["bot", "person", "unknown"]),
      name: z.string().min(1),
      handle: z.string().min(1).optional(),
    })
    .optional(),
  effectiveAuthor: z.enum(EFFECTIVE_AUTHOR),
  botSlug: z.enum(BOT_SLUGS).optional(),
});
