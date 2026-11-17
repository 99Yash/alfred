/**
 * Triage categories (ADR-0121, the nine labels). Here, not in `@alfred/integrations`, so the
 * web bundle can import them. The loud question comes first: `urgent`, `action`, and `reply`
 * say the mail needs Yash. Every other label is quiet.
 */

import { z } from "zod";
import { enumGuard } from "./guards";

export const TRIAGE_CATEGORIES = [
  "urgent",
  "action",
  "reply",
  "meeting",
  "receipt",
  "fyi",
  "done",
  "news",
  "promo",
] as const;

/**
 * The stored category ids before the rename (triage-theory-v1 slice 2). One migration maps
 * `email_triage.category`; these are for readers of rows and JSON that a migration missed or
 * that must still parse: `model_verdict`, `email_triage_changes`, stored snapshots.
 */
export type LegacyTriageCategory =
  | "action_needed"
  | "follow_up"
  | "awaiting_reply"
  | "payment"
  | "newsletter"
  | "marketing";

/** Old id → new id. `follow_up` and `awaiting_reply` share `reply`; the split is gone. */
export const LEGACY_TRIAGE_CATEGORY_MAP = {
  action_needed: "action",
  follow_up: "reply",
  awaiting_reply: "reply",
  payment: "receipt",
  newsletter: "news",
  marketing: "promo",
} as const satisfies Record<LegacyTriageCategory, TriageCategory>;

const CATEGORY_BY_ANY_ID = new Map<string, TriageCategory>([
  ...TRIAGE_CATEGORIES.map((id) => [id, id] as const),
  ...Object.entries(LEGACY_TRIAGE_CATEGORY_MAP),
]);

/**
 * A category id that may still carry a pre-rename value: a new id passes, a legacy id maps.
 * Anything else is `null`, so a caller decides its own fallback.
 */
export function migrateTriageCategory(value: string): TriageCategory | null {
  return CATEGORY_BY_ANY_ID.get(value) ?? null;
}

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export const TRIAGE_RAIL_SUPPRESSED_CATEGORIES = [
  "news",
  "promo",
] as const satisfies readonly TriageCategory[];

/** Short display label for the rail chip. */
export const TRIAGE_DISPLAY = {
  urgent: "Urgent",
  action: "Action",
  reply: "Reply",
  meeting: "Meeting",
  receipt: "Receipt",
  fyi: "FYI",
  done: "Done",
  news: "News",
  promo: "Promo",
} satisfies Record<TriageCategory, string>;

export const isTriageCategory = enumGuard(TRIAGE_CATEGORIES);

export const triageCategorySchema = z.enum(TRIAGE_CATEGORIES);

/** `auto`: the classifier wrote the tag. `user`: the user overrode it. Discriminates `SyncedTriageTag`. */
export const TRIAGE_TAG_SOURCES = ["auto", "user"] as const;

export type TriageTagSource = (typeof TRIAGE_TAG_SOURCES)[number];

// ─── Classifier todo proposal (ADR-0050) ────────────────────────────────────
// Here so the `email_triage` row can type against it.
// The row persists them so a `classify` retry can re-mint the todo.

export const TODO_DECISION_OUTCOMES = [
  "proposed",
  "no_obligation",
  "not_significant",
  "would_not_forget",
  "too_vague",
  "already_handled",
] as const;

export type TodoDecisionOutcome = (typeof TODO_DECISION_OUTCOMES)[number];

/** Non-null only when the email passes every rubric test. `nullish` because the model emits `null`. */
export const triageTodoSuggestionSchema = z
  .object({
    name: z.string().min(1).max(120),
    /** How to approach it, or "can't act yet". */
    assist: z.string().max(280).nullish(),
  })
  .nullable();

export type TriageTodoSuggestion = z.infer<typeof triageTodoSuggestionSchema>;

/**
 * Which rubric test decided the todo. `outcome === 'proposed'` iff a suggestion exists.
 * Stored rows from before the rubric left still parse; the code-side suppressions read a
 * `proposed` whose note starts `cold_sender:`, `manufactured:`, or `advisory:` as failed.
 */
/** The `todoDecision.note` cap. A floor that writes a note cuts it here. */
export const TRIAGE_TODO_DECISION_NOTE_MAX_CHARS = 200;

export const triageTodoDecisionSchema = z.object({
  outcome: z.enum(TODO_DECISION_OUTCOMES),
  note: z.string().max(TRIAGE_TODO_DECISION_NOTE_MAX_CHARS).nullish(),
});

export type TriageTodoDecision = z.infer<typeof triageTodoDecisionSchema>;

// ─── Collaboration-tool activity kind (ADR-0066) ───────────────────────────
// What a ClickUp, Linear, or Jira notification is. Null for other mail.
// A floor demotes passive team activity from a group or service sender to fyi.
export const COLLAB_ACTIVITY_KINDS = [
  // Directed at the user: keep the category.
  "assigned_to_user",
  "mentioned_user",
  "comment_to_user",
  // Passive team activity: demote to fyi.
  "state_change",
  "other_activity",
  "digest",
] as const;

export type CollabActivityKind = (typeof COLLAB_ACTIVITY_KINDS)[number];

export const collabActivitySchema = z.enum(COLLAB_ACTIVITY_KINDS);

/** Kinds that obligate the user. The sender-kind floor never demotes these. */
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

// Compile error unless every kind is in exactly one of ownership or passive: a kind in neither
// list is a key of `missing`, a kind in both is a key of `overlap`, and any key makes `{}`
// unassignable.
export const COLLAB_ACTIVITY_PARTITION_CHECK = { missing: {}, overlap: {} } satisfies {
  missing: Record<
    Exclude<CollabActivityKind, OwnershipCollabActivityKind | PassiveCollabActivityKind>,
    never
  >;
  overlap: Record<Extract<OwnershipCollabActivityKind, PassiveCollabActivityKind>, never>;
};

export function isOwnershipCollabActivity(kind: CollabActivityKind): boolean {
  // SAFETY: every member is a CollabActivityKind; widening only lets .includes take `kind`.
  return (COLLAB_ACTIVITY_OWNERSHIP_KINDS as readonly CollabActivityKind[]).includes(kind);
}

export function isPassiveCollabActivity(kind: CollabActivityKind): boolean {
  // SAFETY: every member is a CollabActivityKind; widening only lets .includes take `kind`.
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

/** Bots `extractSenderContext` can identify. Add slugs only from observed decision traces. */
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

/** Who the body reads as, when not the envelope sender (a bot that relays a human). */
export const BODY_ACTOR_KINDS = ["bot", "person", "unknown"] as const;

export type BodyActorKind = (typeof BODY_ACTOR_KINDS)[number];

export const senderContextSchema = z.object({
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

export type SenderContext = z.infer<typeof senderContextSchema>;
