/**
 * Canonical triage category list. Lives in `@alfred/contracts` so the
 * web bundle can import it without pulling in the Node-only
 * `@alfred/integrations` package. `@alfred/integrations/google/labels`
 * re-exports `TRIAGE_CATEGORIES` and `TriageCategory` from here and adds
 * the integration-specific Gmail label-name mapping on top — there is
 * only one source of truth.
 */

import { z } from "zod";
import { enumGuard } from "./guards";

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

export const isTriageCategory = enumGuard(TRIAGE_CATEGORIES);

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
 *
 * The cheap model sometimes VIOLATES its own rubric — returning `proposed` while
 * the `note` carries a failing-outcome prefix (`cold_sender:` / `manufactured:` /
 * `advisory:`, all documented to accompany `not_significant`). `resolveTodoSuggestion`
 * treats that contradiction as a suppression (no todo), so a `proposed` decision
 * whose note names a disqualifying reason is honored downstream as `not_significant`.
 */
export const triageTodoDecisionSchema = z.object({
  outcome: z.enum(TODO_DECISION_OUTCOMES),
  note: z.string().max(200).nullish(),
});
export type TriageTodoDecision = z.infer<typeof triageTodoDecisionSchema>;

// ─── Collaboration-tool activity kind (#218 / ADR-0066) ───────────────────
// A structured read of WHAT a collaboration-tool notification (ClickUp, Linear,
// Jira, Asana, Notion, Trello, doc-comment threads) represents. The cheap
// classifier emits it alongside the category so a deterministic floor can demote
// PASSIVE team activity from a confident group/service sender — the residual
// `action_needed` leak that no body-regex reason (`collab_state_transition`,
// `github_passive_pr_or_ci`, …) safely catches. Null for any mail that is NOT a
// collaboration-tool notification. Rule 12e already asks the model to classify
// these by ownership; this surfaces that read as a field the floor can gate on
// (a structured signal, not another prompt patch).
export const COLLAB_ACTIVITY_KINDS = [
  // Directed AT the user — the ball is in their court. These KEEP their category.
  "assigned_to_user",
  "mentioned_user",
  "comment_to_user",
  // Passive team activity — not the user's obligation. These DEMOTE to fyi.
  "state_change",
  "other_activity",
  "digest",
] as const;
export type CollabActivityKind = (typeof COLLAB_ACTIVITY_KINDS)[number];
export const collabActivitySchema = z.enum(COLLAB_ACTIVITY_KINDS);

/**
 * The subset directed AT the user (assignment, @-mention, or a comment/reply to
 * them). A collaboration notification of one of these kinds genuinely obligates
 * the user, so the sender-kind floor must NOT demote it — only the passive
 * complement (`state_change` / `other_activity` / `digest`) demotes.
 */
export const COLLAB_ACTIVITY_OWNERSHIP_KINDS = [
  "assigned_to_user",
  "mentioned_user",
  "comment_to_user",
] as const satisfies readonly CollabActivityKind[];
export type OwnershipCollabActivityKind = (typeof COLLAB_ACTIVITY_OWNERSHIP_KINDS)[number];

export const COLLAB_ACTIVITY_PASSIVE_KINDS = [
  "state_change",
  "other_activity",
  "digest",
] as const satisfies readonly CollabActivityKind[];
export type PassiveCollabActivityKind = (typeof COLLAB_ACTIVITY_PASSIVE_KINDS)[number];

// Compile-time partition guard: a newly-added kind must be explicitly classified
// as ownership or passive before the sender-kind floor can consume it.
export const COLLAB_ACTIVITY_PARTITION_CHECK: Record<
  Exclude<CollabActivityKind, OwnershipCollabActivityKind | PassiveCollabActivityKind>,
  never
> &
  Record<Extract<OwnershipCollabActivityKind, PassiveCollabActivityKind>, never> = {};

export function isOwnershipCollabActivity(kind: CollabActivityKind): boolean {
  return (COLLAB_ACTIVITY_OWNERSHIP_KINDS as readonly CollabActivityKind[]).includes(kind);
}

export function isPassiveCollabActivity(kind: CollabActivityKind): boolean {
  return (COLLAB_ACTIVITY_PASSIVE_KINDS as readonly CollabActivityKind[]).includes(kind);
}

export type CollabActivityPartition = "ownership" | "passive" | "none";

export function collabActivityPartition(
  kind: CollabActivityKind | null | undefined,
): CollabActivityPartition {
  if (kind == null) return "none";
  return isPassiveCollabActivity(kind) ? "passive" : "ownership";
}

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
 * `triage.classification` decision-trace evidence, never speculation.
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

/**
 * The actor a message body reads as, when it differs from the envelope sender
 * (a bot relaying a human, etc.). Single source for the literal set — the
 * interface is source-of-truth (`senderContextSchema` is annotated
 * `z.ZodType<SenderContext>`, so `z.infer` here would be a TS2456 circular ref).
 */
export const BODY_ACTOR_KINDS = ["bot", "person", "unknown"] as const;
export type BodyActorKind = (typeof BODY_ACTOR_KINDS)[number];

export interface SenderContext {
  fromKind: SenderKind;
  bodyActor?: {
    kind: BodyActorKind;
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
      kind: z.enum(BODY_ACTOR_KINDS),
      name: z.string().min(1),
      handle: z.string().min(1).optional(),
    })
    .optional(),
  effectiveAuthor: z.enum(EFFECTIVE_AUTHOR),
  botSlug: z.enum(BOT_SLUGS).optional(),
});
