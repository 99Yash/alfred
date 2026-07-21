import { type SenderContext } from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { Observations } from "../observations";
import { applyMeetingDemotionFloor, type MeetingDemotionReason } from "./meeting";
import { applyOverrideFloor } from "./override";
import { applySenderKindDemotionFloor, type SenderKindDemotionReason } from "./sender-kind";

/**
 * Deterministic post-classification floors (ADR-0051 §5, #210/#218/#354).
 *
 * Three floors wrap the cheap model's category in a fixed sequence and hold the
 * guarantees the natural-language prompt only asks for as judgment. The pairing
 * is deliberate — each floor is the deterministic HALF of a `SYSTEM_PROMPT` rule:
 *
 *   - override      ↔ nothing in the prompt (the one pure severity guarantee)
 *   - sender-kind   ↔ rules 8a/12e/12f (passive group/service activity → fyi)
 *   - meeting       ↔ rules 7/8/9 (recap/prep/relay/AGM/public-event ≠ meeting)
 *
 * The prompt owns JUDGMENT; the floor owns the GUARANTEE. A policy change on one
 * of those rules has one obvious home per half. Individual floors are exported
 * for their unit tests; `classifyEmail` consumes only {@link applyFloors}.
 */
export { applyOverrideFloor, matchesExposedSecret } from "./override";
export {
  applySenderKindDemotionFloor,
  isGithubNotificationSender,
  matchesCollabIntrinsicStake,
  matchesPrThread,
  type SenderKindDemotionFloorContext,
  type SenderKindDemotionReason,
} from "./sender-kind";
export { applyMeetingDemotionFloor, type MeetingDemotionReason } from "./meeting";

/** Everything the floor sequence reads about one email. Assembled by `classifyEmail`. */
export interface FloorContext {
  /** Subject + body + snippet, lowercased — the override + regex signal surface. */
  signalText: string;
  /** Body + snippet only (no subject) — collab intrinsic-stake vetoes ignore imperative task titles. */
  collabVetoText: string;
  senderKind: Observations["senderKind"];
  effectiveAuthor: SenderContext["effectiveAuthor"] | null;
  sender: string | null;
  subject: string | null;
  to: string | null;
  cc: string | null;
  accountEmail: string | null;
  contentFlags: Pick<Observations["content"], "hasInvestorNotice" | "hasPublicEventLanguage">;
}

/** The floor sequence's verdict — the final classification plus per-floor audit facts. */
export interface FloorOutcome {
  classification: TriageClassification;
  override: { matched: boolean; forced: boolean };
  senderKind: { demoted: boolean; reason: SenderKindDemotionReason | null };
  meeting: { demoted: boolean; reason: MeetingDemotionReason | null };
}

/**
 * Run the three deterministic floors in order over a classification. The secret
 * ESCALATION floor runs first so a leaked secret escapes the sender-kind
 * demotion entirely and keeps any legitimate security todo. The sender-kind
 * DEMOTION then handles confident group/no-reply senders when the demand is
 * structurally passive. The meeting-gate floor runs last: it only fires on a
 * surviving `meeting` tag, so a secret-escalated `urgent` or a sender-kind-demoted
 * `fyi` is already past meeting and left untouched. PURE.
 */
export function applyFloors(classification: TriageClassification, ctx: FloorContext): FloorOutcome {
  const override = applyOverrideFloor(classification, ctx.signalText);
  const kind = applySenderKindDemotionFloor(override.classification, ctx.senderKind, {
    signalText: ctx.signalText,
    collabVetoText: ctx.collabVetoText,
    sender: ctx.sender,
    subject: ctx.subject,
    to: ctx.to,
    cc: ctx.cc,
    accountEmail: ctx.accountEmail,
    collabActivity: override.classification.collabActivity ?? null,
  });
  const meeting = applyMeetingDemotionFloor(kind.classification, {
    effectiveAuthor: ctx.effectiveAuthor,
    senderKind: ctx.senderKind,
    subject: ctx.subject,
    collabActivity: kind.classification.collabActivity ?? null,
    contentFlags: ctx.contentFlags,
  });
  return {
    classification: meeting.classification,
    override: { matched: override.matched, forced: override.forced },
    senderKind: { demoted: kind.demoted, reason: kind.reason },
    meeting: { demoted: meeting.demoted, reason: meeting.reason },
  };
}
