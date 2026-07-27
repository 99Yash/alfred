import { type SenderContext } from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { Observations } from "../observations";
import { applyFloorVerdict, type FloorResult } from "./floor";
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

/**
 * A floor bound to the shared {@link FloorContext}. Each entry maps the one
 * context onto its floor's own arguments; nothing else about a floor is restated
 * here, and no floor sees the previous floor's audit — only its classification.
 */
type FloorApply<R extends FloorResult> = (
  classification: TriageClassification,
  ctx: FloorContext,
) => R;

/**
 * The `model` tag a floor contributes when it fires, read off the floor's OWN
 * result — `""` for a floor that did not. Registering it next to the floor is
 * what keeps the classifier's model id honest: it used to be three
 * `if (floors.x.y) model_id += "…"` lines in `classifyEmail`, which a fourth
 * floor had to remember to extend from another file.
 */
type FloorModelIdTag<R extends FloorResult> = (audit: R) => string;

/**
 * Registers one floor. Both callbacks are typed against the floor's OWN result,
 * but the entry only exposes `run` — a uniform `(classification, ctx)` the fold
 * can call while holding a union of entries. The floor's result IS its audit:
 * `run` applies the verdict and hands the whole result back untouched, so a
 * floor has no way to report an audit that disagrees with what it did.
 */
function floor<N extends string, R extends FloorResult>(
  name: N,
  apply: FloorApply<R>,
  modelIdTag: FloorModelIdTag<R>,
) {
  return {
    name,
    run: (input: TriageClassification, ctx: FloorContext) => {
      const audit = apply(input, ctx);
      return {
        classification: applyFloorVerdict(input, audit.verdict),
        audit,
        modelIdTag: modelIdTag(audit),
      };
    },
  } as const;
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
 * prevent it). Adding a fourth floor is one entry here plus ONE the compiler
 * demands: {@link FloorAudits} derives its key from `name` and its shape from the
 * floor's return type, its model-id tag is registered on the same line, and
 * `ClassifyAudit` carries the audits verbatim — but the persisted decision trace
 * is flat by necessity, so `FLOOR_TRACE_PROJECTIONS`
 * (`../sender-extraction-event.ts`) is keyed on {@link FloorAudits} and fails to
 * compile until the new floor says which flat fields it contributes. That is the
 * one thing a floor cannot derive: what its facts should be CALLED in a record
 * the over-tag audits query by name.
 */
const FLOOR_SEQUENCE = [
  floor(
    "override",
    (classification, ctx) => applyOverrideFloor(classification, ctx.signalText),
    (audit) => (audit.verdict.kind === "escalate" ? "+floor" : ""),
  ),
  floor(
    "senderKind",
    (classification, ctx) =>
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
    (audit) => (audit.verdict.kind === "demote" ? "+kindfloor" : ""),
  ),
  floor(
    "meeting",
    (classification, ctx) =>
      applyMeetingDemotionFloor(classification, {
        effectiveAuthor: ctx.effectiveAuthor,
        senderKind: ctx.senderKind,
        subject: ctx.subject,
        collabActivity: classification.collabActivity ?? null,
        contentFlags: ctx.contentFlags,
      }),
    (audit) => (audit.verdict.kind === "demote" ? "+meetingfloor" : ""),
  ),
] as const;

/**
 * Per-floor audit facts, keyed by floor name — derived from the sequence, never
 * restated. Exported because it is what the persisted decision trace keys its
 * per-floor projections on: registering that map against THIS type is what turns
 * a fourth floor into a missing key there, rather than a demotion production can
 * see fire but not attribute.
 */
export type FloorAudits = {
  [S in (typeof FLOOR_SEQUENCE)[number] as S["name"]]: ReturnType<S["run"]>["audit"];
};

/** The floor sequence's verdict. `audits` crosses onto `ClassifyAudit` verbatim. */
export interface FloorOutcome {
  /** What the floors folded to — the classification `classifyEmail` returns. */
  classification: TriageClassification;
  /**
   * Per-floor audit facts, keyed by floor name. NESTED rather than spread beside
   * the fold's own fields: a floor named `classification` or `modelIdTags` would
   * otherwise typecheck and then silently overwrite one of them at runtime, and
   * `email_triage.model` is notNull, so the garbage would persist. There is no
   * name to collide with here.
   */
  audits: FloorAudits;
  /** `model` tags from the floors that fired, in sequence order; empty when none did. */
  modelIdTags: string[];
}

/**
 * Fold {@link FLOOR_SEQUENCE} over a classification: each floor sees the previous
 * floor's classification and contributes its audit under its own name. PURE.
 * The ordering rationale lives on the sequence itself.
 */
export function applyFloors(classification: TriageClassification, ctx: FloorContext): FloorOutcome {
  let current = classification;
  const modelIdTags: string[] = [];
  const audits: Record<string, unknown> = {};
  for (const step of FLOOR_SEQUENCE) {
    const result = step.run(current, ctx);
    current = result.classification;
    audits[step.name] = result.audit;
    if (result.modelIdTag) modelIdTags.push(result.modelIdTag);
  }
  // Localized cast: the loop fills exactly one key per sequence entry, which is
  // the same set `FloorAudits` derives from it. The public type stays precise per
  // floor via that mapped type, so callers never see this widening.
  return { classification: current, audits: audits as FloorAudits, modelIdTags };
}
