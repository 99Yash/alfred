import {
  type AccountPersona,
  type CollabActivityKind,
  type JsonObject,
  type SenderContext,
  type StandingInstructionTargetKind,
} from "@alfred/contracts";
import { type TriageCategory } from "@alfred/integrations/google";
import type { ClassifyAudit, TriageClassification } from "./classify";
import type { FloorAudits } from "./floors";
import type { Observations } from "./observations";
import type { SenderContextResult } from "./sender-context";
import type { TriageSenderKindSignal } from "./sender-kind";
import type { SenderSuppressionMatch } from "../knowledge";

/** One floor's audit as flat trace fields. `null` means no floor ran (the fallback path). */
type FloorTraceProjection<K extends keyof FloorAudits> = (
  audit: FloorAudits[K] | null,
) => JsonObject;

/**
 * Each floor's trace fields, exhaustive over {@link FloorAudits}, so a new floor
 * cannot demote without a trace field. Flat because ad-hoc SQL groups on these
 * keys. Exported for `floors.test.ts`.
 */
export const FLOOR_TRACE_PROJECTIONS = {
  override: (audit) => ({
    /** The exposed-secret signal matched. */
    floorMatched: audit?.matched ?? false,
    /** It also forced `urgent`. */
    floorForced: audit?.verdict.kind === "escalate",
  }),
  senderKind: (audit) => ({
    senderKindDemotedCategory: audit?.verdict.kind === "demote",
    senderKindDemotionReason: audit?.reason ?? null,
  }),
  meeting: (audit) => ({
    meetingDemotedCategory: audit?.verdict.kind === "demote",
    meetingDemotionReason: audit?.reason ?? null,
  }),
  spam: (audit) => ({
    /** A reply lane went to `fyi` (rule 20). */
    spamDemotedCategory: audit?.verdict.kind === "demote",
    /**
     * `demoted_reply_lane`, `held_demand_lane` (spam stayed urgent, #1098), or null.
     * Not named `spamDemotionReason`: a query on that key silently reads NULL.
     * Count demotions with `= 'demoted_reply_lane'`; `IS NOT NULL` over-counts.
     * Who held the lane: `floorForced = true` means the override floor; before #1188
     * see `floors/spam.ts`.
     */
    spamFloorOutcome: audit?.outcome ?? null,
  }),
} satisfies { [K in keyof FloorAudits]: FloorTraceProjection<K> };

type UnionToIntersection<U> = (U extends unknown ? (of: U) => void : never) extends (
  of: infer I,
) => void
  ? I
  : never;

/** Read off the registry, so a missing floor fails once, at the registry. */
type ProjectedFloorName = keyof typeof FLOOR_TRACE_PROJECTIONS;

type FloorTraceFields = UnionToIntersection<
  ReturnType<(typeof FLOOR_TRACE_PROJECTIONS)[ProjectedFloorName]>
>;

function floorTraceFields(floors: FloorAudits | null): FloorTraceFields {
  const fields: JsonObject = {};

  // SAFETY: FLOOR_TRACE_PROJECTIONS is keyed by ProjectedFloorName, so its
  // keys enumerate exactly those names.
  for (const name of Object.keys(FLOOR_TRACE_PROJECTIONS) as ProjectedFloorName[]) {
    // SAFETY: name came from the table's own keys; `satisfies` checked each entry.
    const project = FLOOR_TRACE_PROJECTIONS[name] as FloorTraceProjection<ProjectedFloorName>;
    Object.assign(fields, project(floors?.[name] ?? null));
  }

  // SAFETY: the loop assigned one field-set per projected floor above.
  return fields as FloorTraceFields;
}

/**
 * The `triage.classification` decision trace: enough to debug a bad tag without
 * the email body. Written in the same transaction as the triage row.
 */
export interface SenderExtractionEvent extends FloorTraceFields {
  fromKind: SenderContext["fromKind"];
  bodyActor: SenderContext["bodyActor"] | null;
  effectiveAuthor: SenderContext["effectiveAuthor"];
  botSlug: string | null;
  parserHit: SenderContextResult["parserHit"];
  senderAddress: SenderContextResult["senderAddress"];
  senderDomain: SenderContextResult["senderDomain"];
  persona: AccountPersona | null;
  senderPriorKey: string | null;
  senderPriorCounts: Record<string, number>;
  knownContact: boolean;
  senderRelationship: string | null;
  senderKind: TriageSenderKindSignal["kind"] | null;
  senderKindConfidence: number | null;
  senderKindEvidenceCodes: string[];
  senderKindDemotedPersonTreatment: boolean;
  threadMessages: number;
  threadNewest: Observations["thread"]["newestDirection"];
  gmailImportant: boolean;
  gmailCategories: string[];
  gmailSpam: boolean;
  contentFlags: Observations["content"];
  firstPassCategory: TriageCategory | null;
  firstPassConfidence: number | null;
  firstPassCollabActivity: CollabActivityKind | null;
  conflict: NonNullable<ClassifyAudit["conflict"]>["kind"] | null;
  secondPassCategory: TriageCategory | null;
  secondPassCollabActivity: CollabActivityKind | null;
  secondPassFailure: string | null;
  finalCategory: TriageCategory;
  finalConfidence: number;
  finalCollabActivity: CollabActivityKind | null;
  todoSuggested: boolean;
  standingInstructionSuppressedTodo: boolean;
  standingInstructionFactId: string | null;
  standingInstructionEffect: string | null;
  /** The only field that shows whether a domain-scoped instruction ever fires. */
  standingInstructionMatchedVia: StandingInstructionTargetKind | null;
  standingInstructionReadFailed: boolean;
  /**
   * The instruction in the prompt. The fields above report the later todo read;
   * only this one can explain `finalCategory`. Read with its `ReadFailed` flag.
   */
  standingInstructionCategoryFactId: string | null;
  standingInstructionCategoryReadFailed: boolean;
  /**
   * Mirrors the `if (obs.userContext)` render branch in `classify.ts`. Change both together.
   * With `userContextReadFailed`: present (T, F), absent (F, F), failed (F, T).
   */
  userContextPresent: boolean;
  userContextReadFailed: boolean;
  todoOutcome: string | null;
  todoNote: string | null;
}

export function senderExtractionEvent(args: {
  senderContextResult: SenderContextResult;
  observations: Observations;
  audit: ClassifyAudit | null;
  classification: TriageClassification;
  todoSuggested: boolean;
  standingSuppression: SenderSuppressionMatch | null;
  standingSuppressionReadFailed: boolean;
}): SenderExtractionEvent {
  const { context } = args.senderContextResult;
  const obs = args.observations;
  const audit = args.audit;

  return {
    // sender
    fromKind: context.fromKind,
    bodyActor: context.bodyActor ?? null,
    effectiveAuthor: context.effectiveAuthor,
    botSlug: context.botSlug ?? null,
    parserHit: args.senderContextResult.parserHit,
    senderAddress: args.senderContextResult.senderAddress,
    senderDomain: args.senderContextResult.senderDomain,
    // observations
    persona: obs.persona,
    senderPriorKey: obs.senderPrior.key,
    senderPriorCounts: obs.senderPrior.categoryCounts,
    knownContact: obs.knownContact,
    senderRelationship: obs.senderRelationship,
    senderKind: obs.senderKind?.kind ?? null,
    senderKindConfidence: obs.senderKind?.confidence ?? null,
    senderKindEvidenceCodes: obs.senderKind?.evidenceCodes ?? [],
    senderKindDemotedPersonTreatment: Boolean(obs.senderKind),
    // floors
    ...floorTraceFields(audit?.floors ?? null),
    threadMessages: obs.thread.messageCount,
    threadNewest: obs.thread.newestDirection,
    gmailImportant: obs.gmail.important,
    gmailCategories: obs.gmail.categories,
    gmailSpam: obs.gmail.spam,
    contentFlags: obs.content,
    // classify audit (null on the fallback/default path)
    firstPassCategory: audit?.firstPass.category ?? null,
    firstPassConfidence: audit?.firstPass.confidence ?? null,
    firstPassCollabActivity: audit?.firstPass.collabActivity ?? null,
    conflict: audit?.conflict?.kind ?? null,
    secondPassCategory: audit?.secondPass?.category ?? null,
    secondPassCollabActivity: audit?.secondPass?.collabActivity ?? null,
    secondPassFailure: audit?.secondPassFailure?.message ?? null,
    // final outcome
    finalCategory: args.classification.category,
    finalConfidence: args.classification.confidence,
    finalCollabActivity: args.classification.collabActivity ?? null,
    todoSuggested: args.todoSuggested,
    standingInstructionSuppressedTodo: Boolean(args.standingSuppression),
    standingInstructionFactId: args.standingSuppression?.factId ?? null,
    standingInstructionEffect: args.standingSuppression?.effect ?? null,
    standingInstructionMatchedVia: args.standingSuppression?.matchedVia ?? null,
    standingInstructionReadFailed: args.standingSuppressionReadFailed,
    standingInstructionCategoryFactId: obs.standingInstruction?.factId ?? null,
    standingInstructionCategoryReadFailed: obs.standingInstructionReadFailed,
    userContextPresent: obs.userContext !== null,
    userContextReadFailed: obs.userContextReadFailed,
    todoOutcome: args.classification.todoDecision?.outcome ?? null,
    todoNote: args.classification.todoDecision?.note ?? null,
  };
}

// Module augmentation, not an import: `ctx.trace` stays typed and execution never imports triage.
declare module "@alfred/assistant/execution/decision-traces" {
  interface DecisionTraceRegistry {
    "triage.classification": SenderExtractionEvent;
  }
}
