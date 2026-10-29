import {
  isDemandCategory,
  sanitizeErrorMessage,
  standingInstructionEffectApplies,
  standingInstructionEffectRaises,
  TRIAGE_TODO_DECISION_NOTE_MAX_CHARS,
  type StandingInstructionCoverage,
  type StandingInstructionEffect,
  type StandingInstructionEffectKind,
  type StandingInstructionTargetKind,
  type TriageCategory,
  type TriageModelVerdict,
} from "@alfred/contracts";
import type { ActiveStandingInstruction } from "../../knowledge";
import type { FloorDemotionKey } from "./floor";

/**
 * The instruction floor (ADR-0113). It runs after the system floors, on the stored model
 * verdict, so triage and every later consumer derive the same effective result from it.
 * It replaces the ADR-0110 sender floor: a v1 row reads as a target with `demote_demand`
 * and `block_todo_suggestion`, so its category result is the same.
 */

/** How one instruction reached this mail. A target hit covers the whole mail (E2). */
export type StandingInstructionMatchVia =
  | { kind: "target"; targetKind: StandingInstructionTargetKind }
  | { kind: "scope"; reason: string; covers: StandingInstructionCoverage };

export type StandingInstructionMatch = ActiveStandingInstruction & {
  via: StandingInstructionMatchVia;
};

/** The fields the effects read and write. A caller merges the result into its other fields. */
export type StandingEffectVerdict = Pick<
  TriageModelVerdict,
  "category" | "documentAsk" | "todoSuggestion" | "todoDecision"
>;

/**
 * What one effect of one matched instruction did.
 *  - `applied`: it changed the result.
 *  - `no_change`: it applied, and the result already had its value.
 *  - `part_cover`: a lowering effect on a scope match that the model said covers only part.
 *  - `held_secret`: a lowering category effect lost to the exposed-secret signal.
 *  - `cancelled`: an exception of this instruction also matched (`exceptionOf`).
 *  - `not_triage`: a briefing or reply-draft effect. Its consumer applies it.
 */
export type StandingEffectResult =
  | "applied"
  | "no_change"
  | "part_cover"
  | "held_secret"
  | "cancelled"
  | "not_triage";

export interface StandingEffectAudit {
  instructionId: string;
  revision: number;
  factId: string;
  /** The match kind. A scope match also carries the model's reason and cover. */
  match: StandingInstructionMatchVia;
  effect: StandingInstructionEffectKind;
  result: StandingEffectResult;
}

/**
 * The ADR-0110 trace value, kept so that old queries still count the same thing. Null means
 * neither. Count demotions with `= 'demoted_demand_lane'`; `IS NOT NULL` over-counts.
 *  - `demoted_demand_lane`: the model verdict was `urgent` or `action_needed`, and the
 *    effective category is neither.
 *  - `held_secret_lane`: the exposed-secret signal held a lowering category effect.
 */
export type StandingFloorOutcome = "demoted_demand_lane" | "held_secret_lane";

/** The floor's output. `reason` is the rationale clause, or null when nothing applied. */
export interface StandingFloorResult {
  result: StandingEffectVerdict;
  audit: StandingFloorAudit;
  reason: string | null;
}

export interface StandingFloorAudit {
  effects: StandingEffectAudit[];
  /** Instruction ids that an exception of theirs cancelled on this mail. */
  cancelled: string[];
  outcome: StandingFloorOutcome | null;
}

/** The category an effect moves `current` to, or null for an effect that sets no category. */
function categoryAfter(
  effect: StandingInstructionEffect,
  current: TriageCategory,
): TriageCategory | null {
  switch (effect.kind) {
    case "demote_urgent":
      return current === "urgent" ? "action_needed" : current;
    case "demote_demand":
      return isDemandCategory(current) ? "fyi" : current;
    case "demote_meeting":
      return current === "meeting" ? "fyi" : current;
    case "force_category":
      return effect.category;
    case "block_todo_suggestion":
    case "exclude_briefing_priority":
    case "include_briefing_priority":
    case "block_reply_draft":
      return null;
    default: {
      const exhaustive: never = effect;

      return exhaustive;
    }
  }
}

interface AppliedEffect {
  match: StandingInstructionMatch;
  effect: StandingInstructionEffect;
}

/** Triage applies these. A briefing or reply-draft effect is for its own consumer. */
const IS_TRIAGE_EFFECT = {
  demote_urgent: true,
  demote_demand: true,
  demote_meeting: true,
  force_category: true,
  block_todo_suggestion: true,
  exclude_briefing_priority: false,
  include_briefing_priority: false,
  block_reply_draft: false,
} satisfies Record<StandingInstructionEffectKind, boolean>;

/**
 * `demote_demand` and `demote_meeting` say "not a thing to do", so they also clear the ask and
 * the todo. `force_category` sets only the category, even to `fyi`: the user asked for a lane,
 * and `block_todo_suggestion` is the separate effect that clears the todo.
 */
const CLEARS_OBLIGATION = {
  demote_urgent: false,
  demote_demand: true,
  demote_meeting: true,
  force_category: false,
  block_todo_suggestion: false,
  exclude_briefing_priority: false,
  include_briefing_priority: false,
  block_reply_draft: false,
} satisfies Record<StandingInstructionEffectKind, boolean>;

const STANDING_FLOOR_KEY: FloorDemotionKey = "standing_floor";

/**
 * The `todoDecision.note`: the instruction that cleared the todo, a different instruction
 * that also blocked it, and last the model's reason for a scope match, so the cap cuts the
 * reason first. The audit keeps every effect in full.
 */
function floorNote(
  noteBy: StandingInstructionMatch,
  alsoBlockedBy: StandingInstructionMatch | null,
): string {
  const parts = [
    `${STANDING_FLOOR_KEY}: instruction ${describeMatch(noteBy)} (fact ${noteBy.factId})`,
    ...(alsoBlockedBy && alsoBlockedBy.value.instructionId !== noteBy.value.instructionId
      ? [`todo also blocked by ${describeMatch(alsoBlockedBy)}`]
      : []),
    ...(noteBy.via.kind === "scope" ? [`reason: ${noteBy.via.reason}`] : []),
  ];

  return sanitizeErrorMessage(parts.join("; "), TRIAGE_TODO_DECISION_NOTE_MAX_CHARS);
}

function describeMatch(match: StandingInstructionMatch): string {
  return `${match.value.instructionId} r${match.value.revision}, ${match.via.kind}`;
}

/**
 * Apply the effects of every matched instruction to the model verdict (ADR-0113). Pure, so
 * a consumer that reads the stored verdict and the current matches gets the triage result.
 *  1. An exception cancels the instruction it names, on this mail only.
 *  2. Instructions apply oldest first, so the later write wins a conflict.
 *  3. A lowering effect needs full cover (E2). A target hit is full cover.
 *  4. The security floor holds a lowering category effect and never a raise.
 */
export function applyStandingInstructionEffects(
  verdict: StandingEffectVerdict,
  context: { exposedSecret: boolean; matches: readonly StandingInstructionMatch[] },
): StandingFloorResult {
  const matchedIds = new Set(context.matches.map((match) => match.value.instructionId));

  const cancelledIds = new Set(
    context.matches.flatMap((match) => {
      const broader = match.value.exceptionOf;

      return broader !== undefined && matchedIds.has(broader) ? [broader] : [];
    }),
  );

  const ordered = [...context.matches].sort(
    (a, b) => a.validFrom.getTime() - b.validFrom.getTime() || a.factId.localeCompare(b.factId),
  );

  const effects: StandingEffectAudit[] = [];
  const clauses: string[] = [];

  let category = verdict.category;
  let categorySetBy: AppliedEffect | null = null;
  let todoBlockedBy: StandingInstructionMatch | null = null;
  let heldSecret = false;

  for (const match of ordered) {
    const coverage: StandingInstructionCoverage =
      match.via.kind === "target" ? "all" : match.via.covers;

    for (const effect of match.value.effects) {
      const record = (result: StandingEffectResult) =>
        effects.push({
          instructionId: match.value.instructionId,
          revision: match.value.revision,
          factId: match.factId,
          match: match.via,
          effect: effect.kind,
          result,
        });

      if (cancelledIds.has(match.value.instructionId)) {
        record("cancelled");
        continue;
      }

      if (!IS_TRIAGE_EFFECT[effect.kind]) {
        record("not_triage");
        continue;
      }

      if (
        !standingInstructionEffectApplies(effect, { coverage, modelCategory: verdict.category })
      ) {
        record("part_cover");
        continue;
      }

      if (effect.kind === "block_todo_suggestion") {
        if (verdict.todoSuggestion === null || todoBlockedBy !== null) {
          record("no_change");
          continue;
        }

        todoBlockedBy = match;
        clauses.push(`blocked the todo suggestion (${describeMatch(match)})`);
        record("applied");
        continue;
      }

      const next = categoryAfter(effect, category);

      if (next === null || next === category) {
        record("no_change");
        continue;
      }

      if (context.exposedSecret && !standingInstructionEffectRaises(effect, verdict.category)) {
        heldSecret = true;
        record("held_secret");
        continue;
      }

      clauses.push(`${category} → ${next} (${describeMatch(match)})`);
      category = next;
      categorySetBy = { match, effect };
      record("applied");
    }
  }

  const clearsObligation =
    categorySetBy !== null &&
    category !== verdict.category &&
    CLEARS_OBLIGATION[categorySetBy.effect.kind];

  const noteBy = clearsObligation ? categorySetBy?.match : todoBlockedBy;
  const alsoBlockedBy = clearsObligation ? todoBlockedBy : null;

  const result: StandingEffectVerdict = {
    ...verdict,
    category,
    ...(clearsObligation ? { documentAsk: null } : {}),
    ...(clearsObligation || todoBlockedBy !== null ? { todoSuggestion: null } : {}),
    ...(noteBy
      ? { todoDecision: { outcome: "no_obligation", note: floorNote(noteBy, alsoBlockedBy) } }
      : {}),
  };

  return {
    result,
    audit: {
      effects,
      cancelled: [...cancelledIds],
      outcome: heldSecret
        ? "held_secret_lane"
        : isDemandCategory(verdict.category) && !isDemandCategory(category)
          ? "demoted_demand_lane"
          : null,
    },
    reason:
      clauses.length > 0
        ? `Standing instruction floor: the user's own instructions moved ${clauses.join("; ")}.`
        : null,
  };
}
