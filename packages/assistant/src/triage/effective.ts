import {
  standingInstructionHasEffect,
  type StandingInstructionEffectKind,
  type TriageInstructionEvaluation,
} from "@alfred/contracts";
import type { ActiveStandingInstruction, LoadedMailStandingInstructions } from "../knowledge";
import {
  applyStandingConsumerEffects,
  applyStandingInstructionEffects,
  type StandingConsumerEffects,
  type StandingEffectVerdict,
  type StandingFloorAudit,
  type StandingInstructionMatch,
} from "./floors";
import type { TriageRow } from "./store";

/**
 * The effective triage result at read time (ADR-0113, "Lifetime of a stored match"). Triage,
 * briefing gather, the briefing reads, and the reply-draft gate call this one function, so
 * they cannot disagree.
 *  1. Target hits come from the current instructions, never from the row.
 *  2. A stored scope result counts only for the document that triage evaluated, and only at
 *     the instruction's current `revision`. Every other current scoped instruction is `unknown`.
 *  3. The result comes from the stored model verdict, so a removed instruction stops at once.
 *  4. `unknown` follows the effect: a rank effect does nothing, and a block makes its output wait.
 */

/** The row fields the derivation reads. Null when triage never wrote a row for the thread. */
export type EffectiveTriageRow = Pick<
  TriageRow,
  | "documentId"
  | "category"
  | "documentAsk"
  | "todoSuggestion"
  | "todoDecision"
  | "modelVerdict"
  | "instructionEvaluation"
>;

/** A block effect whose output waits while one of its instructions is `unknown`. */
export type StandingBlockEffectKind = Extract<
  StandingInstructionEffectKind,
  "block_todo_suggestion" | "block_reply_draft"
>;

export interface EffectiveTriage extends StandingConsumerEffects {
  /** The effective category, ask, and todo. Null when no row exists. */
  result: StandingEffectVerdict | null;
  /**
   * The instruction floor's audit. Null when the row has no model verdict (a row from before
   * ADR-0113, or the classifier fallback): then the cached row is the result.
   */
  floor: StandingFloorAudit | null;
  /** The current matches: every target hit and every current `matched` scope result. */
  matches: StandingInstructionMatch[];
  /** Current scoped instructions with no current stored result. */
  unknown: ActiveStandingInstruction[];
}

export interface CurrentScopeResults {
  /** The current `matched` scope results, as matches. */
  matched: StandingInstructionMatch[];
  /** Current scoped instructions with no current stored result. */
  unknown: ActiveStandingInstruction[];
}

/**
 * Rule 2: a stored scope result counts only at the instruction's current `revision`. Pass
 * `evaluation` only for the document it was made for.
 */
export function currentScopeResults(
  evaluation: TriageInstructionEvaluation | null,
  scoped: readonly ActiveStandingInstruction[],
): CurrentScopeResults {
  const stored = new Map(evaluation?.scopes.map((scope) => [scope.instructionId, scope]));

  const matched: StandingInstructionMatch[] = [];
  const unknown: ActiveStandingInstruction[] = [];

  for (const instruction of scoped) {
    const scope = stored.get(instruction.value.instructionId);

    if (scope === undefined || scope.revision !== instruction.value.revision) {
      unknown.push(instruction);
      continue;
    }

    if (scope.state === "matched") {
      matched.push({
        ...instruction,
        via: { kind: "scope", reason: scope.reason, covers: scope.covers },
      });
    }
  }

  return { matched, unknown };
}

/**
 * Derive the effective result for one document. `documentId` is the document the consumer
 * decides for. A stored scope result counts only when it equals the row's document.
 */
export function deriveEffectiveTriage(args: {
  triage: EffectiveTriageRow | null;
  documentId: string;
  instructions: LoadedMailStandingInstructions;
}): EffectiveTriage {
  const { triage, instructions } = args;

  const evaluation =
    triage !== null && triage.documentId === args.documentId ? triage.instructionEvaluation : null;

  const scoped = currentScopeResults(evaluation, instructions.scoped);

  const matches: StandingInstructionMatch[] = [
    ...instructions.targetHits.map(({ matchedVia, ...instruction }) => ({
      ...instruction,
      via: { kind: "target" as const, targetKind: matchedVia },
    })),
    ...scoped.matched,
  ];

  const { unknown } = scoped;

  const verdict = triage?.modelVerdict ?? null;

  // A row with no model verdict keeps its cached result, which already holds the effects of
  // its own run. Applying them again could undo a secret hold that the row cannot show.
  const floor = verdict
    ? applyStandingInstructionEffects(
        {
          category: verdict.category,
          documentAsk: verdict.documentAsk,
          todoSuggestion: verdict.todoSuggestion,
          todoDecision: verdict.todoDecision,
        },
        { exposedSecret: verdict.exposedSecret, matches },
      )
    : null;

  const result: StandingEffectVerdict | null = floor
    ? floor.result
    : triage
      ? {
          category: triage.category,
          documentAsk: triage.documentAsk,
          todoSuggestion: triage.todoSuggestion,
          todoDecision: triage.todoDecision,
        }
      : null;

  const consumer = applyStandingConsumerEffects({
    // With no row, only a raise can fail its direction test. `fyi` makes no raise look lower.
    modelCategory: verdict?.category ?? triage?.category ?? "fyi",
    exposedSecret: verdict?.exposedSecret ?? false,
    matches,
  });

  return { ...consumer, result, floor: floor?.audit ?? null, matches, unknown };
}

/**
 * The `unknown` instructions that carry a block. Its output waits until the state is known
 * (ADR-0113 rule 4). An output that the user asks for does not wait.
 */
export function standingBlockWaitsOn(
  effective: Pick<EffectiveTriage, "unknown">,
  kind: StandingBlockEffectKind,
): ActiveStandingInstruction[] {
  return effective.unknown.filter((instruction) =>
    standingInstructionHasEffect(instruction.value, kind),
  );
}
