/**
 * Reply-drafting result contract (PRD #236, foundation #243; ADR-0097).
 *
 * Alfred drafts a reply only for a message that deserves one, and every run
 * ends in ONE of five typed outcomes. Four of them are successful decisions
 * NOT to stage anything — `no_draft`, `clarification`, `no_access`, `withheld`
 * — and they are first-class rows, not exceptional paths, so the system can
 * prove it chose not to draft for a reason instead of silently skipping.
 *
 * Browser-safe: the settings and history surfaces read these to render what a
 * run decided. The gate and verifier that PRODUCE a result live server-side in
 * `@alfred/assistant/reply-drafting`; this file owns only the shapes.
 */

import { z } from "zod";
import { significanceBandSchema } from "./attention";
import { enumGuard } from "./guards";
import { triageCategorySchema, triageTodoDecisionSchema, type TriageCategory } from "./triage";

// ─── Outcomes ─────────────────────────────────────────────────────────────

export const REPLY_DRAFT_OUTCOMES = [
  /** A gated `gmail.send_draft` action was staged for the user to approve. */
  "staged",
  /** The message does not deserve a drafted reply. Carries a gate reason. */
  "no_draft",
  /** A reply is warranted but a fact or target is ambiguous; ask the user. */
  "clarification",
  /** Alfred lacks the Gmail connection or scope needed to send at all. */
  "no_access",
  /** A draft was composed but the verifier refused to stage it. */
  "withheld",
] as const;
export type ReplyDraftOutcome = (typeof REPLY_DRAFT_OUTCOMES)[number];
export const replyDraftOutcomeSchema = z.enum(REPLY_DRAFT_OUTCOMES);

/**
 * How the run was started. `post_triage` is the proactive background path and
 * is bound by the feature flag; `manual` is an explicit smoke or user request
 * that bypasses the flag and the worthiness rubric but NOT the structural
 * blockers. Recorded on every result so telemetry never mixes the two.
 */
export const REPLY_DRAFT_INVOCATIONS = ["post_triage", "manual"] as const;
export type ReplyDraftInvocation = (typeof REPLY_DRAFT_INVOCATIONS)[number];
export const replyDraftInvocationSchema = z.enum(REPLY_DRAFT_INVOCATIONS);

/**
 * Triage categories whose shape is "someone wrote to the user and expects an
 * answer". A reply-expected category is NECESSARY for a proactive draft, never
 * sufficient: the worthiness gate applies its own rubric on top. `urgent` and
 * `action_needed` are deliberately absent — they describe an obligation, not a
 * conversation, and a wrong draft there is costlier than a missed one.
 */
export const REPLY_EXPECTED_TRIAGE_CATEGORIES = [
  "awaiting_reply",
  "follow_up",
] as const satisfies readonly TriageCategory[];
export const isReplyExpectedTriageCategory = enumGuard(REPLY_EXPECTED_TRIAGE_CATEGORIES);

/**
 * Below this classifier confidence the tag is a soft-confirm ("alfred wasn't
 * sure"), and a proactive draft must not build on it. Same threshold the rail
 * uses for the soft-confirm hint.
 */
export const REPLY_DRAFT_MIN_TRIAGE_CONFIDENCE = 0.5;

// ─── Reason codes, one closed set per outcome ─────────────────────────────

/**
 * Why the worthiness gate (or the composer seam) returned `no_draft`. The
 * order here is the order the gate evaluates them in; the first failing test
 * names the reason.
 */
export const REPLY_NO_DRAFT_REASONS = [
  /** Sender is a bot or a service; nobody is waiting for a human answer. */
  "sender_not_person",
  /** The user has already replied after this message arrived. */
  "user_already_replied",
  /** `feature.reply_drafting` is off and the invocation was proactive. */
  "feature_disabled",
  /** An active standing instruction suppresses drafting for this sender. */
  "standing_instruction",
  /** Triage fell back to the default category; the tag is not evidence. */
  "classifier_fallback",
  /** Category is not in `REPLY_EXPECTED_TRIAGE_CATEGORIES`. */
  "category_not_reply_expected",
  /** Classifier confidence is below `REPLY_DRAFT_MIN_TRIAGE_CONFIDENCE`. */
  "low_confidence",
  /** Rule 16b cold contact: weak significance, one-way inbound, or no history. */
  "cold_sender",
  /** The relationship read did not corroborate a two-way contact. */
  "relationship_unverified",
  /** Triage judged the mail carries no real obligation or stake. */
  "not_significant",
  /** Triage judged the ask is already handled. */
  "already_handled",
  /** The gate passed but no composer exists yet (#237 adds it). */
  "composer_unavailable",
] as const;
export type ReplyNoDraftReason = (typeof REPLY_NO_DRAFT_REASONS)[number];
export const replyNoDraftReasonSchema = z.enum(REPLY_NO_DRAFT_REASONS);

export const REPLY_NO_ACCESS_REASONS = [
  /** No active Google credential for this mailbox. */
  "gmail_not_connected",
  /** The credential exists but was never granted `gmail.send`. */
  "gmail_send_scope_missing",
] as const;
export type ReplyNoAccessReason = (typeof REPLY_NO_ACCESS_REASONS)[number];
export const replyNoAccessReasonSchema = z.enum(REPLY_NO_ACCESS_REASONS);

/** Why the verifier refused to stage a composed draft. */
export const REPLY_WITHHELD_REASONS = [
  "missing_thread_id",
  "missing_recipient",
  /** A recipient is the user's own mailbox. */
  "recipient_is_self",
  /** A recipient does not appear on the inbound thread's headers. */
  "recipient_not_in_thread",
  /** A factual claim in the body has no gathered object behind it. */
  "unsupported_claim",
  "empty_body",
] as const;
export type ReplyWithheldReason = (typeof REPLY_WITHHELD_REASONS)[number];
export const replyWithheldReasonSchema = z.enum(REPLY_WITHHELD_REASONS);

export const REPLY_CLARIFICATION_REASONS = [
  /** More than one gathered object matches the request (two PRs, two docs). */
  "ambiguous_object",
  /** The thread has several people and the right recipient is unclear. */
  "ambiguous_recipient",
] as const;
export type ReplyClarificationReason = (typeof REPLY_CLARIFICATION_REASONS)[number];
export const replyClarificationReasonSchema = z.enum(REPLY_CLARIFICATION_REASONS);

/**
 * What a `staged` outcome actually staged. `gmail.send_draft` sends live mail
 * after approval — it does not create a Gmail Draft — so the action kind says
 * so, and an audit that reads `approval_staged_send` cannot overstate what
 * happened. A real `drafts.create` tool adds a second member here.
 */
export const REPLY_DRAFT_ACTION_KINDS = ["approval_staged_send"] as const;
export type ReplyDraftActionKind = (typeof REPLY_DRAFT_ACTION_KINDS)[number];
export const replyDraftActionKindSchema = z.enum(REPLY_DRAFT_ACTION_KINDS);

// ─── Provenance bundle ────────────────────────────────────────────────────

/**
 * The triage facts the drafting decision relied on, frozen at decision time.
 * A later re-classify of the thread must not make the recorded decision
 * ambiguous, so the snapshot travels with the result instead of being joined
 * back to the live `email_triage` row.
 */
export const replyDraftTriageSnapshotSchema = z.object({
  documentId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  /** The `email-triage` run that wrote the row, or null for a user override. */
  triageRunId: z.string().nullable(),
  category: triageCategorySchema,
  confidence: z.number(),
  /** Classifier model identifier; `"fallback"` marks a default-category row. */
  model: z.string(),
  todoDecision: triageTodoDecisionSchema.nullable(),
  senderRelationshipIsCold: z.boolean().nullable(),
  senderSignificanceBand: significanceBandSchema.nullable(),
});
export type ReplyDraftTriageSnapshot = z.infer<typeof replyDraftTriageSnapshotSchema>;

/** Which style profile the draft used, or the honest absence of one. */
export const replyDraftStyleSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile"), styleProfileId: z.string().min(1) }),
  z.object({ kind: z.literal("style_missing") }),
]);
export type ReplyDraftStyleSelection = z.infer<typeof replyDraftStyleSelectionSchema>;

/**
 * One external object the draft may cite. A placeholder slot at #243: the
 * GitHub PR resolver (#239) fills `github_pull_request` entries; nothing
 * produces them yet, and a claim with no object behind it is `unsupported`.
 */
export const REPLY_GATHERED_OBJECT_KINDS = ["github_pull_request"] as const;
export const replyDraftGatheredObjectSchema = z.object({
  kind: z.enum(REPLY_GATHERED_OBJECT_KINDS),
  /** Stable reference the resolver used (URL, `owner/repo#number`). */
  ref: z.string().min(1),
  status: z.enum(["resolved", "unresolved", "ambiguous"]),
  /** Grounded, quotable facts about the object; the only prose a draft may assert. */
  facts: z.array(z.string()),
});
export type ReplyDraftGatheredObject = z.infer<typeof replyDraftGatheredObjectSchema>;

/**
 * What the verifier's decision is bound to. It names the exact facts bundle,
 * not the generated prose, so a later edit to the body cannot inherit a pass
 * that was granted to different recipients or a different style profile.
 */
export const replyDraftVerifierBindingSchema = z.object({
  sourceThreadId: z.string().nullable(),
  recipients: z.array(z.string()),
  claimCount: z.number().int().nonnegative(),
  style: replyDraftStyleSelectionSchema,
  featureFlagEnabled: z.boolean(),
});
export type ReplyDraftVerifierBinding = z.infer<typeof replyDraftVerifierBindingSchema>;

export const replyDraftVerifierDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("pass"), boundTo: replyDraftVerifierBindingSchema }),
  z.object({
    decision: z.literal("block"),
    reason: replyWithheldReasonSchema,
    detail: z.string().optional(),
    boundTo: replyDraftVerifierBindingSchema,
  }),
]);
export type ReplyDraftVerifierDecision = z.infer<typeof replyDraftVerifierDecisionSchema>;

/**
 * The provenance bundle every result carries. Fields that a run never reached
 * are `null` or empty rather than absent, so a `no_draft` decided before
 * gathering and a `withheld` decided after it have the same shape.
 */
export const replyDraftProvenanceSchema = z.object({
  invocation: replyDraftInvocationSchema,
  /** Flag state at decision time. `manual` runs record it but do not obey it. */
  featureFlagEnabled: z.boolean(),
  triage: replyDraftTriageSnapshotSchema.nullable(),
  inbound: z.object({
    documentId: z.string().min(1),
    sourceThreadId: z.string().nullable(),
    /** Gmail message id of the inbound document, when known. */
    messageId: z.string().nullable(),
  }),
  /** Canonical sender address of the inbound message, or null when unparseable. */
  sender: z.string().nullable(),
  recipients: z.object({ to: z.array(z.string()), cc: z.array(z.string()) }),
  style: replyDraftStyleSelectionSchema.nullable(),
  gatheredObjects: z.array(replyDraftGatheredObjectSchema),
  verifier: replyDraftVerifierDecisionSchema.nullable(),
});
export type ReplyDraftProvenance = z.infer<typeof replyDraftProvenanceSchema>;

// ─── The result ───────────────────────────────────────────────────────────

const resultBase = { provenance: replyDraftProvenanceSchema };

export const replyDraftResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("staged"),
    actionKind: replyDraftActionKindSchema,
    /** `action_stagings.id` of the parked approval, when the dispatcher returned one. */
    stagingId: z.string().nullable(),
    ...resultBase,
  }),
  z.object({
    outcome: z.literal("no_draft"),
    reason: replyNoDraftReasonSchema,
    /** Short free-text detail (a fact id, a rubric note). Never user-facing prose. */
    note: z.string().nullable(),
    ...resultBase,
  }),
  z.object({
    outcome: z.literal("clarification"),
    reason: replyClarificationReasonSchema,
    /** The question to put to the user. */
    question: z.string().min(1),
    ...resultBase,
  }),
  z.object({
    outcome: z.literal("no_access"),
    reason: replyNoAccessReasonSchema,
    ...resultBase,
  }),
  z.object({
    outcome: z.literal("withheld"),
    reason: replyWithheldReasonSchema,
    detail: z.string().nullable(),
    ...resultBase,
  }),
]);
export type ReplyDraftResult = z.infer<typeof replyDraftResultSchema>;
