import { type SenderContext } from "@alfred/contracts";
import type { TriageClassification } from "../classify";
import type { Observations } from "../observations";
import { applyFloorVerdict, type FloorResult } from "./floor";
import { applyMeetingDemotionFloor } from "./meeting";
import { applyOverrideFloor } from "./override";
import { applySenderKindDemotionFloor } from "./sender-kind";
import { applySpamDemotionFloor } from "./spam";

/**
 * Deterministic floors after the model (ADR-0051 §5). The prompt owns judgment;
 * each floor guarantees one prompt rule:
 *   - override    ↔ none (exposed secret → urgent)
 *   - sender-kind ↔ rules 8a/12e/12f
 *   - spam        ↔ rule 20
 *   - meeting     ↔ rules 7/8/9
 */
export {
  applyOverrideFloor,
  matchesExposedCredentialClaim,
  matchesExposedSecret,
} from "./override";

export {
  applySenderKindDemotionFloor,
  isGithubNotificationSender,
  matchesCollabIntrinsicStake,
  matchesPrThread,
} from "./sender-kind";

export { applyMeetingDemotionFloor } from "./meeting";

export { applySpamDemotionFloor } from "./spam";

/** Everything the floor sequence reads about one email. Assembled by `classifyEmail`. */
export interface FloorContext {
  /** Lowercased subject + body + snippet. */
  signalText: string;
  /** No subject: a task title's imperative is not a stake. */
  collabVetoText: string;
  isSpam: boolean;
  senderKind: Observations["senderKind"];
  effectiveAuthor: SenderContext["effectiveAuthor"] | null;
  sender: string | null;
  subject: string | null;
  to: string | null;
  cc: string | null;
  accountEmail: string | null;
  contentFlags: Pick<Observations["content"], "hasInvestorNotice" | "hasPublicEventLanguage">;
}

type FloorApply<R extends FloorResult> = (
  classification: TriageClassification,
  ctx: FloorContext,
) => R;

/** The `model` tag when the floor fires, else `""`. */
type FloorModelIdTag<R extends FloorResult> = (audit: R) => string;

/** Register one floor. Its result is its audit, so the audit cannot disagree with the verdict. */
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
 * Order is the policy. Each floor sees the previous floor's output.
 *  1. `override` first, so a leaked secret escapes the sender-kind demotion.
 *  2. `senderKind` demotes passive group/no-reply mail.
 *  3. `spam` demotes reply lanes only. After `senderKind` so the audit names the
 *     sender reason when both match; the category is the same.
 *  4. `meeting` last: it only fires on a surviving `meeting` tag.
 * A new floor also needs an entry in `FLOOR_TRACE_PROJECTIONS`; the compiler asks for it.
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
    "spam",
    (classification, ctx) => applySpamDemotionFloor(classification, ctx.isSpam),
    (audit) => (audit.verdict.kind === "demote" ? "+spamfloor" : ""),
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

/** Per-floor audits, keyed by floor name and derived from the sequence. */
export type FloorAudits = {
  [S in (typeof FLOOR_SEQUENCE)[number] as S["name"]]: ReturnType<S["run"]>["audit"];
};

export interface FloorOutcome {
  classification: TriageClassification;
  /** Nested, so a floor named `classification` cannot overwrite a sibling field. */
  audits: FloorAudits;
  modelIdTags: string[];
}

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

  // SAFETY: the loop above fills every FLOOR_SEQUENCE entry before returning.
  return { classification: current, audits: audits as FloorAudits, modelIdTags };
}
