import { type SenderContext } from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { Observations } from "../observations";
import { applyMeetingDemotionFloor } from "./meeting";
import { applyOverrideFloor } from "./override";
import { applySenderKindDemotionFloor } from "./sender-kind";

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

/** What every floor returns: the (possibly changed) classification plus its own audit facts. */
interface FloorResult {
  classification: TriageClassification;
}

/**
 * A floor bound to the shared {@link FloorContext}. Each entry maps the one
 * context onto its floor's own arguments; nothing else about a floor is restated
 * here, and no floor sees the previous floor's audit — only its classification.
 */
type FloorApply<R extends FloorResult> = (
  classification: TriageClassification,
  ctx: FloorContext,
) => R;

function floor<N extends string, R extends FloorResult>(name: N, apply: FloorApply<R>) {
  return { name, apply } as const;
}

/**
 * The floor sequence. ORDER IS THE POLICY, so it lives here as data rather than
 * as the shape of a function body:
 *
 *  1. `override` — the secret ESCALATION runs first so a leaked secret escapes
 *     the sender-kind demotion entirely and keeps any legitimate security todo.
 *  2. `senderKind` — the DEMOTION for confident group/no-reply senders whose
 *     demand is structurally passive.
 *  3. `meeting` — the meeting gate runs last: it only fires on a surviving
 *     `meeting` tag, so a secret-escalated `urgent` or a sender-kind-demoted
 *     `fyi` is already past it and left untouched.
 *
 * Each floor receives the PREVIOUS floor's classification because {@link applyFloors}
 * folds the list — the threading is structural, not something each new floor has
 * to remember to do (passing the original `classification` instead of the prior
 * floor's output would silently disable a floor, and nothing but care used to
 * prevent it). Adding a fourth floor is one entry: {@link FloorOutcome} derives
 * its audit key from `name` and its audit shape from the floor's return type.
 */
const FLOOR_SEQUENCE = [
  floor("override", (classification, ctx) => applyOverrideFloor(classification, ctx.signalText)),
  floor("senderKind", (classification, ctx) =>
    applySenderKindDemotionFloor(classification, ctx.senderKind, {
      signalText: ctx.signalText,
      collabVetoText: ctx.collabVetoText,
      sender: ctx.sender,
      subject: ctx.subject,
      to: ctx.to,
      cc: ctx.cc,
      accountEmail: ctx.accountEmail,
      collabActivity: classification.collabActivity ?? null,
    }),
  ),
  floor("meeting", (classification, ctx) =>
    applyMeetingDemotionFloor(classification, {
      effectiveAuthor: ctx.effectiveAuthor,
      senderKind: ctx.senderKind,
      subject: ctx.subject,
      collabActivity: classification.collabActivity ?? null,
      contentFlags: ctx.contentFlags,
    }),
  ),
] as const;

/** Per-floor audit facts, keyed by floor name — derived from the sequence, never restated. */
type FloorAudits = {
  [S in (typeof FLOOR_SEQUENCE)[number] as S["name"]]: Omit<
    ReturnType<S["apply"]>,
    "classification"
  >;
};

/** The floor sequence's verdict — the final classification plus per-floor audit facts. */
export type FloorOutcome = { classification: TriageClassification } & FloorAudits;

/**
 * Fold {@link FLOOR_SEQUENCE} over a classification: each floor sees the previous
 * floor's classification and contributes its audit under its own name. PURE.
 * The ordering rationale lives on the sequence itself.
 */
export function applyFloors(classification: TriageClassification, ctx: FloorContext): FloorOutcome {
  let current = classification;
  const audits: Record<string, unknown> = {};
  for (const step of FLOOR_SEQUENCE) {
    const { classification: next, ...audit } = step.apply(current, ctx);
    current = next;
    audits[step.name] = audit;
  }
  // Localized cast: the loop fills exactly one key per sequence entry, which is
  // the same set `FloorAudits` derives from it. The public type stays precise per
  // floor via that mapped type, so callers never see this widening.
  return { classification: current, ...audits } as FloorOutcome;
}
