import {
  isReplyExpectedTriageCategory,
  REPLY_DRAFT_MIN_TRIAGE_CONFIDENCE,
  type EffectiveAuthor,
  type ReplyDraftInvocation,
  type ReplyDraftProvenance,
  type ReplyDraftResult,
  type ReplyDraftTriageSnapshot,
  type ReplyNoDraftReason,
} from "@alfred/contracts";
import type { GmailMessageEventReason } from "@alfred/assistant/triggers";

/**
 * Reply-worthiness gate (ADR-0098). PURE — no DB, no LLM.
 *
 * The gate is deliberately NOT `category === "awaiting_reply"`. Triage keeps
 * the category honest (a cold ask IS `awaiting_reply`), and the todo rubric
 * already declines to mint a todo for it; drafting needs a HIGHER bar than
 * either, because a wrong outbound draft costs more than a wrong tag. So the
 * gate composes the facts triage already resolved deterministically — the
 * rule-16b cold-contact verdict, the todo rubric outcome, the classifier's
 * confidence and fallback state, thread reply state, sender kind, and any
 * standing instruction — into one ordered rubric. The first failing test names
 * the `no_draft` reason, so a wrong omission is as debuggable as a wrong draft.
 *
 * Two invocation modes share the structural blockers and differ on the rubric:
 *
 *   - `post_triage` (proactive) evaluates every test.
 *   - `manual` (smoke / explicit request) stops after the structural blockers.
 *     It bypasses the feature flag and the rubric — that is what "manual" is
 *     for — but it still refuses to draft a reply to a bot or to a thread the
 *     user has already answered, because no invocation makes those sensible.
 */

/** How a standing-instruction read for `block_reply_draft` resolved. */
export type ReplyStandingInstructionState = "none" | "suppress" | "read_failed";

interface ReplyWorthinessBase {
  featureFlagEnabled: boolean;
  sender: { effectiveAuthor: EffectiveAuthor };
  thread: { inboundAuthoredAt: Date | null; lastUserReplyAt: Date | null };
  /** Why triage ran. `reply` means the user's own outbound reply caused a re-eval. */
  triageReason: GmailMessageEventReason | null;
  standingInstruction: ReplyStandingInstructionState;
}

/**
 * A proactive verdict always has the snapshot the classified event carried; a
 * manual one may run on a thread triage never wrote (no row → `null`).
 */
export type ReplyWorthinessInput = ReplyWorthinessBase &
  (
    | { invocation: Extract<ReplyDraftInvocation, "post_triage">; triage: ReplyDraftTriageSnapshot }
    | {
        invocation: Extract<ReplyDraftInvocation, "manual">;
        triage: ReplyDraftTriageSnapshot | null;
      }
  );

export type ReplyWorthinessDecision =
  | { worthy: true }
  | { worthy: false; reason: ReplyNoDraftReason; note: string | null };

function declined(reason: ReplyNoDraftReason, note: string | null = null): ReplyWorthinessDecision {
  return { worthy: false, reason, note };
}

/** The `no_draft` result for one reason, with the provenance the caller assembled. */
export function noDraftResult(
  reason: ReplyNoDraftReason,
  note: string | null,
  provenance: ReplyDraftProvenance,
): ReplyDraftResult {
  return { outcome: "no_draft", reason, note, provenance };
}

/**
 * True when the user has already answered AFTER the inbound message arrived.
 * The `reply` triage reason is the strongest signal (the re-eval fired because
 * the user sent mail in this thread); the timestamp comparison catches a reply
 * ingested before the inbound message was triaged. Missing timestamps cannot
 * prove a reply, so they fall through — a missed draft is cheaper than a wrong
 * one, but "unknown" is not "already replied".
 */
function userAlreadyReplied(input: ReplyWorthinessBase): boolean {
  if (input.triageReason === "reply") return true;
  const { inboundAuthoredAt, lastUserReplyAt } = input.thread;
  return (
    inboundAuthoredAt != null &&
    lastUserReplyAt != null &&
    lastUserReplyAt.getTime() > inboundAuthoredAt.getTime()
  );
}

export function decideReplyWorthiness(input: ReplyWorthinessInput): ReplyWorthinessDecision {
  // ── Structural blockers: hold for every invocation ──────────────────────
  if (input.sender.effectiveAuthor !== "person") {
    return declined("sender_not_person", input.sender.effectiveAuthor);
  }
  if (userAlreadyReplied(input)) return declined("user_already_replied", input.triageReason);

  if (input.invocation === "manual") return { worthy: true };

  // ── Proactive rubric, in evaluation order ────────────────────────────────
  if (!input.featureFlagEnabled) return declined("feature_disabled");
  if (input.standingInstruction !== "none") {
    return declined("standing_instruction", input.standingInstruction);
  }

  const triage = input.triage;
  if (triage.model === "fallback") return declined("classifier_fallback");
  if (!isReplyExpectedTriageCategory(triage.category)) {
    return declined("category_not_reply_expected", triage.category);
  }
  if (triage.confidence < REPLY_DRAFT_MIN_TRIAGE_CONFIDENCE) {
    return declined("low_confidence", triage.confidence.toFixed(2));
  }
  // Rule 16b: `true` is a corroborated cold contact; `null` means the graph
  // read did not corroborate a two-way relationship (non-human, unscored, or
  // a read failure). A proactive outbound draft needs corroboration, so both
  // decline — under different names, because only the first is a fact about
  // the sender.
  if (triage.senderRelationshipIsCold === true) return declined("cold_sender");
  if (triage.senderRelationshipIsCold === null) return declined("relationship_unverified");

  const todo = triage.todoDecision;
  if (todo?.outcome === "already_handled") return declined("already_handled", todo.note ?? null);
  if (todo?.outcome === "no_obligation" || todo?.outcome === "not_significant") {
    return declined("not_significant", todo.note ?? todo.outcome);
  }

  return { worthy: true };
}
