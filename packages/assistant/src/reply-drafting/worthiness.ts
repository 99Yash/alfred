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
 * Reply-worthiness gate (ADR-0098). Pure: no DB, no LLM.
 * Not just `category === "awaiting_reply"`: a wrong outbound draft costs more than a wrong
 * tag, so the bar is higher. One ordered rubric over facts triage already resolved.
 * The first failing test names the `no_draft` reason.
 * `post_triage` runs every test. `manual` skips the flag and the rubric, but still
 * refuses a bot sender or a thread the user already answered.
 */

/** Result of the `block_reply_draft` instruction read. */
export type ReplyStandingInstructionState = "none" | "suppress" | "read_failed";

interface ReplyWorthinessBase {
  featureFlagEnabled: boolean;
  sender: { effectiveAuthor: EffectiveAuthor };
  thread: { inboundAuthoredAt: Date | null; lastUserReplyAt: Date | null };
  /** `reply` means the user's own reply caused a re-eval. */
  triageReason: GmailMessageEventReason | null;
  standingInstruction: ReplyStandingInstructionState;
}

/** A manual run may hit a thread triage never wrote, so its snapshot can be `null`. */
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

export function noDraftResult(
  reason: ReplyNoDraftReason,
  note: string | null,
  provenance: ReplyDraftProvenance,
): ReplyDraftResult {
  return { outcome: "no_draft", reason, note, provenance };
}

/**
 * The user answered after the inbound message. Triage reason `reply` is the strongest
 * signal; timestamps catch a reply ingested earlier. Missing timestamps prove nothing.
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
  // ── Structural blockers: every invocation ──────────────────────
  if (input.sender.effectiveAuthor !== "person") {
    return declined("sender_not_person", input.sender.effectiveAuthor);
  }

  if (userAlreadyReplied(input)) return declined("user_already_replied", input.triageReason);

  if (input.invocation === "manual") return { worthy: true };

  // ── Proactive rubric, in order ────────────────────────────────
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

  // Rule 16b: `true` is a confirmed cold contact; `null` means no two-way relationship
  // was confirmed. A draft needs confirmation, so both decline, under different reasons.
  if (triage.senderRelationshipIsCold === true) return declined("cold_sender");

  if (triage.senderRelationshipIsCold === null) return declined("relationship_unverified");

  const todo = triage.todoDecision;

  if (todo?.outcome === "already_handled") return declined("already_handled", todo.note ?? null);

  if (todo?.outcome === "no_obligation" || todo?.outcome === "not_significant") {
    return declined("not_significant", todo.note ?? todo.outcome);
  }

  return { worthy: true };
}
