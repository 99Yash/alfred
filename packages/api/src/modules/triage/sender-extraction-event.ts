import {
  type AccountPersona,
  type SenderContext,
} from "@alfred/contracts";
import { type TriageCategory } from "@alfred/integrations/google";
import type { ClassifyAudit, TriageClassification } from "./classify";
import type { Observations } from "./observations";
import type { SenderContextResult } from "./sender-context";
import type { SenderSuppressionMatch } from "../memory/standing-instructions";

/**
 * Flattened observation summary + classify audit for a single classification
 * decision (ADR-0051; formalized as a durable decision trace by ADR-0077,
 * `kind = "triage.classification"`). Enough to debug a bad tag without the raw
 * email body. Persisted via `ctx.trace` into `agent_decision_traces`.
 *
 * Lives in `@alfred/api` (not `@alfred/contracts`) because every field type it
 * composes — `Observations`, `ClassifyAudit`, `SenderContextResult` — is a
 * triage-internal type defined alongside it here; moving it up would drag that
 * whole leaf tree with it. The decision-trace registry (`modules/agent`) imports
 * this type to give `triage.classification` traces their precise shape.
 */
export interface SenderExtractionEvent {
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
  /** Rendered Sender relationship descriptor (ADR-0059), or null for non-human senders — logged for rubric tuning. */
  senderRelationship: string | null;
  threadMessages: number;
  threadNewest: Observations["thread"]["newestDirection"];
  gmailImportant: boolean;
  gmailCategories: string[];
  contentFlags: Observations["content"];
  firstPassCategory: TriageCategory | null;
  firstPassConfidence: number | null;
  conflict: NonNullable<ClassifyAudit["conflict"]>["kind"] | null;
  secondPassCategory: TriageCategory | null;
  secondPassFailure: string | null;
  floorMatched: boolean;
  floorForced: boolean;
  finalCategory: TriageCategory;
  finalConfidence: number;
  todoSuggested: boolean;
  standingInstructionSuppressedTodo: boolean;
  standingInstructionFactId: string | null;
  standingInstructionEffect: string | null;
  standingInstructionReadFailed: boolean;
  /** Which rubric test decided the todo call (rule 16); null on producers that don't emit it. */
  todoOutcome: string | null;
  todoNote: string | null;
}

/**
 * Flatten the observation summary + classify audit into a single structured
 * record (`triage.classification`, ADR-0051 → ADR-0077). Enough to debug a bad
 * tag without the raw email body.
 */
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
    threadMessages: obs.thread.messageCount,
    threadNewest: obs.thread.newestDirection,
    gmailImportant: obs.gmail.important,
    gmailCategories: obs.gmail.categories,
    contentFlags: obs.content,
    // classify audit (null on the fallback/default path)
    firstPassCategory: audit?.firstPass.category ?? null,
    firstPassConfidence: audit?.firstPass.confidence ?? null,
    conflict: audit?.conflict?.kind ?? null,
    secondPassCategory: audit?.secondPass?.category ?? null,
    secondPassFailure: audit?.secondPassFailure?.message ?? null,
    floorMatched: audit?.floorMatched ?? false,
    floorForced: audit?.floorForced ?? false,
    // final outcome
    finalCategory: args.classification.category,
    finalConfidence: args.classification.confidence,
    todoSuggested: args.todoSuggested,
    standingInstructionSuppressedTodo: Boolean(args.standingSuppression),
    standingInstructionFactId: args.standingSuppression?.factId ?? null,
    standingInstructionEffect: args.standingSuppression?.effect ?? null,
    standingInstructionReadFailed: args.standingSuppressionReadFailed,
    todoOutcome: args.classification.todoDecision?.outcome ?? null,
    todoNote: args.classification.todoDecision?.note ?? null,
  };
}
