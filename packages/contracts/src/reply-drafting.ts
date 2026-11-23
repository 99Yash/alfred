import { significanceBandSchema } from "./attention";
/**
 * Reply-drafting result shapes (ADR-0098). Every run ends in one of five outcomes.
 * The four that stage nothing are recorded too, so a skip always has a reason.
 */

import { z } from "zod";
import { enumGuard, parseEmailAddress } from "./guards";
import {
  standingInstructionEvidenceSchema,
  standingInstructionUnknownSchema,
} from "./standing-instructions";
import { triageCategorySchema, triageTodoDecisionSchema, type TriageCategory } from "./triage";

// ─── Outcomes ─────────────────────────────────────────────────────────────

export const REPLY_DRAFT_OUTCOMES = [
  /**
   * A Gmail draft was created on the source thread for the user to review and send.
   * The stored value keeps its old name: the workflow once staged a gated
   * `gmail.send_draft` action (owner decision of 2026-11-15: Alfred makes drafts only).
   */
  "staged",
  /** The message does not deserve a drafted reply. Carries a gate reason. */
  "no_draft",
  /** A reply is warranted but a fact or target is ambiguous; ask the user. */
  "clarification",
  /** Alfred lacks the Gmail connection or scope needed to send at all. */
  "no_access",
  /** A draft was composed but not written: the verifier or a check before the write refused it. */
  "withheld",
] as const;

export type ReplyDraftOutcome = (typeof REPLY_DRAFT_OUTCOMES)[number];

export const replyDraftOutcomeSchema = z.enum(REPLY_DRAFT_OUTCOMES);

/**
 * `post_triage` obeys the feature flag. `manual` skips the flag and the
 * worthiness rubric, but not the structural blockers.
 */
export const REPLY_DRAFT_INVOCATIONS = ["post_triage", "manual"] as const;

export type ReplyDraftInvocation = (typeof REPLY_DRAFT_INVOCATIONS)[number];

export const replyDraftInvocationSchema = z.enum(REPLY_DRAFT_INVOCATIONS);

/**
 * Required for a proactive draft, but not enough alone.
 * `urgent` and `action` are left out: a wrong draft there costs more than a missed one.
 */
export const REPLY_EXPECTED_TRIAGE_CATEGORIES = [
  "reply",
] as const satisfies readonly TriageCategory[];

export const isReplyExpectedTriageCategory = enumGuard(REPLY_EXPECTED_TRIAGE_CATEGORIES);

/** Below this, the triage tag is a soft-confirm and a proactive draft must not use it. */
export const REPLY_DRAFT_MIN_TRIAGE_CONFIDENCE = 0.5;

// ─── Reason codes, one closed set per outcome ─────────────────────────────

/** Why a run returned `no_draft`. */
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
  /** No longer written. Kept so stored runs still parse. */
  "composer_unavailable",
  /** Source was deleted, is not Gmail, or a newer document owns triage. */
  "source_unavailable",
  /** A proactive run has no current triage row. */
  "triage_unavailable",
] as const;

export type ReplyNoDraftReason = (typeof REPLY_NO_DRAFT_REASONS)[number];

export const replyNoDraftReasonSchema = z.enum(REPLY_NO_DRAFT_REASONS);

export const REPLY_NO_ACCESS_REASONS = [
  /** No active Google credential for this mailbox. */
  "gmail_not_connected",
  /**
   * No credential holds the `gmail.modify` grant that `drafts.create` needs. The stored
   * value keeps its old name: it once named the send grant too.
   */
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
  "context_mismatch",
  "invalid_candidate",
  /** No longer written. Kept so stored runs still parse. */
  "staging_unavailable",
  /** Gmail mailbox writes are off in this deployment, so no draft was written. */
  "mailbox_writes_disabled",
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
 * The message the workflow writes with `drafts.create` (the integration client's
 * `createDraft`). Reply drafting builds it in code; the verifier is the only door to it.
 * Recipients must parse as mailbox addresses.
 */
const draftRecipientSchema = z
  .string()
  .refine((value) => parseEmailAddress(value) !== null, "Invalid email address");

export const replyDraftMessageSchema = z.object({
  to: z.array(draftRecipientSchema).min(1).max(25),
  cc: z.array(draftRecipientSchema).max(25).optional(),
  subject: z
    .string()
    .min(1)
    .max(1000)
    .refine((s) => !/[\r\n]/.test(s), {
      message: "subject must not contain line breaks",
    }),
  bodyText: z.string().min(1).max(50_000),
  /** Gmail thread id of the inbound message, so the draft groups into the thread. */
  threadId: z.string().optional(),
});

export type ReplyDraftMessage = z.infer<typeof replyDraftMessageSchema>;

/**
 * Retired: the workflow once staged a gated send (owner decision of 2026-11-15).
 * The stored value stays so recorded runs and traces still parse.
 */
export const REPLY_DRAFT_ACTION_KINDS = ["approval_staged_send"] as const;

export type ReplyDraftActionKind = (typeof REPLY_DRAFT_ACTION_KINDS)[number];

export const replyDraftActionKindSchema = z.enum(REPLY_DRAFT_ACTION_KINDS);

// ─── Provenance bundle ────────────────────────────────────────────────────

/** Triage facts copied at decision time, so a later re-classify cannot change the record. */
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
  /** Kept for stored provenance from before ADR-0127. New runs omit it. */
  senderSignificanceBand: significanceBandSchema.nullable().optional(),
});

export type ReplyDraftTriageSnapshot = z.infer<typeof replyDraftTriageSnapshotSchema>;

/**
 * The `block_reply_draft` read (ADR-0113). `unknown`: an instruction with the block has no
 * current match result for this document, so a proactive draft waits (rule 4).
 */
export const replyDraftStandingInstructionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("suppress"), instruction: standingInstructionEvidenceSchema }),
  z.object({
    state: z.literal("unknown"),
    instructions: z.array(standingInstructionUnknownSchema),
  }),
  z.object({ state: z.literal("read_failed") }),
]);

export type ReplyDraftStandingInstruction = z.infer<typeof replyDraftStandingInstructionSchema>;

/** Which style the draft used. The profile source is retired; only the honest absence remains. */
export const replyDraftStyleSelectionSchema = z.object({
  kind: z.literal("style_missing"),
});

export type ReplyDraftStyleSelection = z.infer<typeof replyDraftStyleSelectionSchema>;

/** A source the draft may cite. An email about a PR is not proof of the PR's current state. */
export const REPLY_GATHERED_OBJECT_KINDS = [
  "github_pull_request",
  "inbound_document",
  "thread_context",
  "user_context",
  "reply_context",
  /** Claims that the user has not confirmed, and summaries that a model wrote (memory.md §9 Q6). */
  "unconfirmed_claims",
] as const;

export type ReplyGatheredObjectKind = (typeof REPLY_GATHERED_OBJECT_KINDS)[number];

/**
 * Whether a source of this kind can support a factual statement in a draft by itself. A `weak`
 * source is agent-concluded and unconfirmed: it can inform the composer, but the verifier blocks a
 * claim whose only support it is (#1897 review, owner decision 2026-11-23).
 */
export const REPLY_GATHERED_OBJECT_SUPPORT = {
  github_pull_request: "strong",
  inbound_document: "strong",
  thread_context: "strong",
  user_context: "strong",
  reply_context: "strong",
  unconfirmed_claims: "weak",
} as const satisfies Record<ReplyGatheredObjectKind, "strong" | "weak">;

export const replyDraftGatheredObjectSchema = z.object({
  kind: z.enum(REPLY_GATHERED_OBJECT_KINDS),
  /** Stable reference the resolver used (URL, `owner/repo#number`). */
  ref: z.string().min(1),
  status: z.enum(["resolved", "unresolved", "ambiguous"]),
  /** Grounded, quotable facts about the object; the only prose a draft may assert. */
  facts: z.array(z.string()),
});

export type ReplyDraftGatheredObject = z.infer<typeof replyDraftGatheredObjectSchema>;

/** The facts a verifier pass covers, so a pass cannot carry over to other recipients or style. */
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

/** Steps a run never reached are `null` or empty, not absent, so every result has one shape. */
export const replyDraftProvenanceSchema = z.object({
  invocation: replyDraftInvocationSchema,
  /** Flag state at decision time. `manual` runs record it but do not obey it. */
  featureFlagEnabled: z.boolean(),
  /** The effective triage result the gate decided on (ADR-0113 rule 3), not the cached row. */
  triage: replyDraftTriageSnapshotSchema.nullable(),
  /** Null when the gate did not read it. A record from before ADR-0113 has no value. */
  standingInstruction: replyDraftStandingInstructionSchema.nullable().default(null),
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
    /** Retired: only runs from before the 2026-11-15 amendment carry it. */
    actionKind: replyDraftActionKindSchema.optional(),
    /** Retired: `action_stagings.id` of the send approval of a run from before 2026-11-15. */
    stagingId: z.string().optional(),
    /** Gmail draft id of the created draft. Runs from before 2026-11-15 have none. */
    draftId: z.string().min(1).optional(),
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
