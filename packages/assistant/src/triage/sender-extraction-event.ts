import {
  type AccountPersona,
  type CollabActivityKind,
  type SenderContext,
} from "@alfred/contracts";
import { type TriageCategory } from "@alfred/integrations/google";
import type { ClassifyAudit, TriageClassification } from "./classify";
import type { FloorAudits } from "./floors";
import type { Observations } from "./observations";
import type { SenderContextResult } from "./sender-context";
import type { TriageSenderKindSignal } from "./sender-kind";
import type { SenderSuppressionMatch } from "../knowledge";

/**
 * How one floor's audit lands on the flat trace record, registered under that
 * floor's name and typed against that floor's OWN audit — the same registration
 * shape `FLOOR_SEQUENCE` uses for a floor's model-id tag. `null` is the
 * audit-less path (the fallback classification, where no floor ran), so each
 * projection states its own "did not fire" value instead of the assembly
 * guessing one per field.
 */
type FloorTraceProjection<K extends keyof FloorAudits> = (
  audit: FloorAudits[K] | null,
) => Record<string, unknown>;

/**
 * Every floor's contribution to the trace, keyed by floor name and EXHAUSTIVE
 * over {@link FloorAudits}. This is the seam a fourth floor would otherwise slip
 * through: registering it in `FLOOR_SEQUENCE` reaches the in-memory audit and the
 * `model` tag on its own, but the persisted `agent_decision_traces` row — the
 * only one of the three the over-tag audits (#210/#354) can query — used to be
 * hand-flattened, so a new floor could demote in production with nothing in the
 * record naming it. A missing key here is now a type error.
 *
 * Flat rather than a nested `floors` object because ad-hoc SQL groups on these
 * keys in the trace's jsonb and the names predate the floor registry (the
 * override floor's fields are still `floorMatched`/`floorForced`). The
 * projection is where that historical name meets the derived shape.
 *
 * Exported for the runtime twin of that type error in `floors.test.ts` — the
 * case where a fourth floor's author widens this annotation instead of adding
 * the entry.
 */
export const FLOOR_TRACE_PROJECTIONS = {
  override: (audit) => ({
    /** True when the override floor's exposed-secret signal matched at all. */
    floorMatched: audit?.matched ?? false,
    /** True when it also had to force the category to `urgent`. */
    floorForced: audit?.verdict.kind === "escalate",
  }),
  senderKind: (audit) => ({
    /** True when the sender-kind floor demoted the final category → `fyi` (#210). */
    senderKindDemotedCategory: audit?.verdict.kind === "demote",
    /** Structured reason for a sender-kind category demotion, if one fired. */
    senderKindDemotionReason: audit?.reason ?? null,
  }),
  meeting: (audit) => ({
    /** True when the meeting-gate floor demoted `meeting` → `fyi`. */
    meetingDemotedCategory: audit?.verdict.kind === "demote",
    /** Structured reason for a meeting-gate demotion, if one fired. */
    meetingDemotionReason: audit?.reason ?? null,
  }),
} satisfies { [K in keyof FloorAudits]: FloorTraceProjection<K> };

/**
 * Collapse a union of object types into one. Local to this file: it exists only
 * to merge the projections' field groups into {@link FloorTraceFields}.
 */
type UnionToIntersection<U> = (U extends unknown ? (of: U) => void : never) extends (
  of: infer I,
) => void
  ? I
  : never;

/**
 * A registered floor, by name. Read off the registry rather than off
 * {@link FloorAudits} so an unregistered fourth floor produces exactly ONE error
 * — the missing key above, which is the edit — instead of cascading through
 * everything downstream that indexes by floor name.
 */
type ProjectedFloorName = keyof typeof FLOOR_TRACE_PROJECTIONS;

/** The floor half of {@link SenderExtractionEvent}, derived from {@link FLOOR_TRACE_PROJECTIONS}. */
type FloorTraceFields = UnionToIntersection<
  ReturnType<(typeof FLOOR_TRACE_PROJECTIONS)[ProjectedFloorName]>
>;

/**
 * Project the floor outcome onto its flat trace fields — or `null` on the
 * audit-less fallback path, where every projection reports its own "did not
 * fire" values. Folding the registry rather than spreading its three entries by
 * hand is what makes registration the only edit a fourth floor needs.
 */
function floorTraceFields(floors: FloorAudits | null): FloorTraceFields {
  const fields: Record<string, unknown> = {};
  // SAFETY: FLOOR_TRACE_PROJECTIONS is keyed by ProjectedFloorName, so its
  // keys enumerate exactly those names.
  for (const name of Object.keys(FLOOR_TRACE_PROJECTIONS) as ProjectedFloorName[]) {
    // Localized casts: `name` and the projection it indexes are correlated by
    // construction, which the compiler cannot follow through the key union. The
    // registry's `satisfies` already checked each entry against its own floor's
    // audit type, and neither widening reaches a caller.
    // SAFETY: name came from the table's own key list, so the indexed entry is
    // that projection.
    const project = FLOOR_TRACE_PROJECTIONS[name] as FloorTraceProjection<ProjectedFloorName>;
    Object.assign(fields, project(floors?.[name] ?? null));
  }
  // SAFETY: the loop assigned one field-set per projected floor above.
  return fields as FloorTraceFields;
}

/**
 * Flattened observation summary + classify audit for a single classification
 * decision (ADR-0051; durable decision-trace PR-A of #219,
 * `kind = "triage.classification"`). Enough to debug a bad tag without the raw
 * email body. Persisted into `agent_decision_traces` through the normal
 * `ctx.trace` seam, with triage also inserting the same keyed row inside the
 * canonical row transaction so a tag cannot commit without its trace.
 *
 * Lives in `@alfred/assistant` (not `@alfred/contracts`) because every field type it
 * composes — `Observations`, `ClassifyAudit`, `SenderContextResult` — is a
 * triage-internal type defined alongside it here; moving it up would drag that
 * whole leaf tree with it. triage declares its own `"triage.classification"`
 * decision-trace kind against execution's open registry at the bottom of this
 * file, so execution never imports this triage-internal type (item 06 removed
 * that last `agent -> triage` edge).
 *
 * Its floor half is NOT declared here: those fields come from
 * {@link FLOOR_TRACE_PROJECTIONS}, so the floor sequence and the persisted record
 * cannot drift apart.
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
  /** Rendered Sender relationship descriptor (ADR-0059), or null for non-human senders — logged for rubric tuning. */
  senderRelationship: string | null;
  /** Active user-model projection kind that demoted person treatment, if any. */
  senderKind: TriageSenderKindSignal["kind"] | null;
  senderKindConfidence: number | null;
  senderKindEvidenceCodes: string[];
  senderKindDemotedPersonTreatment: boolean;
  threadMessages: number;
  threadNewest: Observations["thread"]["newestDirection"];
  gmailImportant: boolean;
  gmailCategories: string[];
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
  standingInstructionReadFailed: boolean;
  /** Which rubric test decided the todo call (rule 16); null on producers that don't emit it. */
  todoOutcome: string | null;
  todoNote: string | null;
}

/**
 * Flatten the observation summary + classify audit into a single structured
 * record (`triage.classification`, ADR-0051 → #219 PR-A). Enough to debug a
 * bad tag without the raw email body.
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
    senderKind: obs.senderKind?.kind ?? null,
    senderKindConfidence: obs.senderKind?.confidence ?? null,
    senderKindEvidenceCodes: obs.senderKind?.evidenceCodes ?? [],
    senderKindDemotedPersonTreatment: Boolean(obs.senderKind),
    // floors — one field group per registered floor, `null` when no floor ran
    ...floorTraceFields(audit?.floors ?? null),
    threadMessages: obs.thread.messageCount,
    threadNewest: obs.thread.newestDirection,
    gmailImportant: obs.gmail.important,
    gmailCategories: obs.gmail.categories,
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
    standingInstructionReadFailed: args.standingSuppressionReadFailed,
    todoOutcome: args.classification.todoDecision?.outcome ?? null,
    todoNote: args.classification.todoDecision?.note ?? null,
  };
}

// Register triage's decision-trace kind against execution's open registry
// (`modules/agent/decision-traces.ts`) from inside the triage boundary. This
// keeps `ctx.trace("triage.classification", …)` tier-1 — a record whose shape
// does not match {@link SenderExtractionEvent} still fails to compile — while
// leaving execution with no static reference to any triage type (the edge item
// 06 removed). Module augmentation, not an `import`, so it adds no module graph
// edge; it applies program-wide because this file is part of the compilation
// and is already imported by the sole producer (`triage/workflow-operations.ts`).
declare module "@alfred/assistant/execution/decision-traces" {
  interface DecisionTraceRegistry {
    "triage.classification": SenderExtractionEvent;
  }
}
