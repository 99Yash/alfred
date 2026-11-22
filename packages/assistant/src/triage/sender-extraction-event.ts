import type {
  AccountPersona,
  CollabActivityKind,
  JsonObject,
  SenderContext,
} from "@alfred/contracts";
import type { TriageCategory } from "@alfred/integrations/google";
import type { ClassifyAudit, StandingClassifyAudit, TriageClassification } from "./classify";
import type { FloorAudits } from "./floors";
import type { Observations } from "./observations";
import type { SenderContextResult } from "../knowledge";

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
  };
}

/**
 * The standing instructions that the prompt carried in words (slice 4a). No code matches or
 * applies an instruction, so the trace counts what the model got. The older `standing*` keys
 * of ADR-0113 stay only on stored traces.
 */
interface StandingTraceFields {
  /** Instructions in the prompt. Null on the fallback path, where no call ran. */
  standingInstructionsSent: number | null;
  /** Instructions left out because the section was over its cap. Null on the fallback path. */
  standingInstructionsOmitted: number | null;
  /** The instruction read failed, so the prompt carried no instruction. */
  standingInstructionsReadFailed: boolean;
}

function standingTraceFields(
  audit: StandingClassifyAudit | null,
  observations: Observations,
): StandingTraceFields {
  return {
    standingInstructionsSent: audit?.sent ?? null,
    standingInstructionsOmitted: audit?.omitted ?? null,
    standingInstructionsReadFailed: observations.standingInstructions?.kind === "read_failed",
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
  /** The one history line for the sender address (ADR-0127); null on a read failure. */
  senderCorrespondentHistory: string | null;
  persona: AccountPersona | null;
  threadMessages: number;
  threadNewest: Observations["thread"]["newestDirection"];
  gmailImportant: boolean;
  gmailCategories: string[];
  gmailSpam: boolean;
  contentFlags: Observations["content"];
  firstPassCategory: TriageCategory | null;
  firstPassConfidence: number | null;
  firstPassCollabActivity: CollabActivityKind | null;
  /** Always null: the conflict re-ask is removed (slice 1). Keys stay for old rows. */
  conflict: NonNullable<ClassifyAudit["conflict"]>["kind"] | null;
  secondPassCategory: TriageCategory | null;
  secondPassCollabActivity: CollabActivityKind | null;
  secondPassFailure: string | null;
  finalCategory: TriageCategory;
  finalConfidence: number;
  finalCollabActivity: CollabActivityKind | null;
  todoSuggested: boolean;
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
  senderCorrespondentHistory: string | null;
  observations: Observations;
  audit: ClassifyAudit | null;
  classification: TriageClassification;
  todoSuggested: boolean;
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
    senderCorrespondentHistory: args.senderCorrespondentHistory,
    // observations
    persona: obs.persona,
    // floors
    ...floorTraceFields(audit?.floors ?? null),
    ...standingTraceFields(audit?.standing ?? null, obs),
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
