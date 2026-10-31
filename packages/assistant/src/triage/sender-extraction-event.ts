import {
  type AccountPersona,
  type CollabActivityKind,
  type JsonObject,
  type SenderContext,
  type StandingInstructionTargetKind,
  type StandingInstructionEvidence,
} from "@alfred/contracts";
import { type TriageCategory } from "@alfred/integrations/google";
import type { ClassifyAudit, StandingClassifyAudit, TriageClassification } from "./classify";
import {
  standingInstructionEvidence,
  type FloorAudits,
  type StandingEffectAudit,
  type StandingFloorOutcome,
} from "./floors";
import type { Observations } from "./observations";
import type { SenderContextResult } from "./sender-context";
import type { TriageSenderKindSignal } from "./sender-kind";
import type { TriageTodoStandingRead } from "./todo-decision";

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

/** The return type is every projection's fields, so a floor left out here fails the build. */
function floorTraceFields(floors: FloorAudits | null): FloorTraceFields {
  const project = FLOOR_TRACE_PROJECTIONS;

  return {
    ...project.override(floors?.override ?? null),
    ...project.senderKind(floors?.senderKind ?? null),
    ...project.meeting(floors?.meeting ?? null),
    ...project.spam(floors?.spam ?? null),
  };
}

/**
 * The instruction floor's trace fields (ADR-0113). It is not a system floor, so it is not in
 * {@link FLOOR_TRACE_PROJECTIONS}. The two ADR-0110 keys keep their names and meaning, so old
 * queries still count the same thing.
 */
interface StandingTraceFields {
  /** The model verdict was `urgent` or `action_needed`, and the effective category is neither. */
  standingDemotedCategory: boolean;
  /**
   * `demoted_demand_lane`, `held_secret_lane` (the exposed-secret signal held a lowering
   * effect), or null. Count demotions with `= 'demoted_demand_lane'`; `IS NOT NULL`
   * over-counts. Who held the lane: `floorForced = true` means the override floor escalated.
   */
  standingFloorOutcome: StandingFloorOutcome | null;
  /** One entry for each effect of each matched instruction, with what it did. */
  standingEffects: StandingEffectAudit[];
  /** Instruction ids that a matched exception cancelled. */
  standingCancelledInstructionIds: string[];
  /** The E3 counter. Null on the fallback path, where no call ran. */
  standingClassOnlyCount: number | null;
  standingKeyedCount: number | null;
  standingClassOnlyTokens: number | null;
  /** Scoped candidates past the allowance. Their state is `unknown`. */
  standingOverflowCount: number | null;
  /**
   * The stored pass's output failed with the match list, so it ran again without it, and every
   * sent instruction is `unknown`. Null when it did not fail, or on the fallback path.
   */
  standingMatchFailure: string | null;
  /**
   * Sent scoped instructions left `unknown` after the call (ADR-0113 rule 4). Null on the
   * fallback path.
   */
  standingUndecidedCount: number | null;
}

function standingTraceFields(audit: StandingClassifyAudit | null): StandingTraceFields {
  return {
    standingDemotedCategory: audit?.floor.outcome === "demoted_demand_lane",
    standingFloorOutcome: audit?.floor.outcome ?? null,
    standingEffects: audit?.floor.effects ?? [],
    standingCancelledInstructionIds: audit?.floor.cancelled ?? [],
    standingClassOnlyCount: audit?.counter.classOnly ?? null,
    standingKeyedCount: audit?.counter.keyed ?? null,
    standingClassOnlyTokens: audit?.counter.classOnlyTokens ?? null,
    standingOverflowCount: audit?.counter.overflow ?? null,
    standingMatchFailure: audit?.matchFailure?.message ?? null,
    standingUndecidedCount: audit?.undecided ?? null,
  };
}

/**
 * The `triage.classification` decision trace: enough to debug a bad tag without
 * the email body. Written in the same transaction as the triage row.
 */
export interface SenderExtractionEvent extends FloorTraceFields, StandingTraceFields {
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
  /**
   * The todo lane held the todo for a `block_todo_suggestion` instruction. Either the state
   * is `unknown` (ADR-0113 rule 4), or a block matched a row with no model verdict. On a row
   * with a verdict, a matched block already cleared the todo, and the floor audit shows it.
   */
  standingInstructionSuppressedTodo: boolean;
  /** The blocking instruction's fact, else the first waiting instruction's fact. */
  standingInstructionFactId: string | null;
  standingInstructionEffect: string | null;
  /** The target kind of a matched block. Null for a scope match and for an `unknown` instruction. */
  standingInstructionMatchedVia: StandingInstructionTargetKind | null;
  /** The full evidence of a matched block: id, revision, and match kind with its scope reason. */
  standingInstructionTodoBlock: StandingInstructionEvidence | null;
  standingInstructionReadFailed: boolean;
  /**
   * The read for the instruction floor failed, so no effect applied. The fields above report
   * the later todo read; the `standing*` fields explain `finalCategory`.
   */
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
  /** The `block_todo_suggestion` state. Flattened below into the stored trace fields. */
  standingSuppression: TriageTodoStandingRead;
}): SenderExtractionEvent {
  const { context } = args.senderContextResult;
  const obs = args.observations;
  const audit = args.audit;

  const standing = args.standingSuppression;
  const waitingOn = standing.kind === "waiting" ? standing.instructions : [];
  const blockedBy = standing.kind === "blocked" ? standing.match : null;
  const holdsTodo = blockedBy !== null || waitingOn.length > 0;

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
    ...standingTraceFields(audit?.standing ?? null),
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
    standingInstructionSuppressedTodo: holdsTodo,
    standingInstructionFactId: blockedBy?.factId ?? waitingOn[0]?.factId ?? null,
    standingInstructionEffect: holdsTodo ? "block_todo_suggestion" : null,
    standingInstructionMatchedVia:
      blockedBy?.via.kind === "target" ? blockedBy.via.targetKind : null,
    standingInstructionTodoBlock: blockedBy ? standingInstructionEvidence(blockedBy) : null,
    standingInstructionReadFailed: standing.kind === "read_failed",
    standingInstructionCategoryReadFailed: obs.standingInstructions?.kind === "read_failed",
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
