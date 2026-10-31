import {
  collapseWhitespace,
  sanitizeErrorMessage,
  standingInstructionCoverageSchema,
  type StandingInstructionScopeResult,
} from "@alfred/contracts";
import { estimateTokens } from "@alfred/corpus";
import { z } from "zod";
import type { ActiveStandingInstruction, MailStandingInstructions } from "../knowledge";
import {
  TRIAGE_INSTRUCTION_BLOCK_MAX_CHARS,
  TRIAGE_INSTRUCTION_MATCH_MAX_ENTRIES,
  TRIAGE_INSTRUCTION_MATCH_REASON_MAX_CHARS,
} from "./constants";
import type { StandingInstructionMatch } from "./floors";

/**
 * The scope match of the classify call (ADR-0113): which scoped instructions go into the
 * prompt, how they render, and how the model's answer becomes stored scope results.
 */

/**
 * The model's decision for one instruction. Only `matched` makes a match. The model writes a
 * decision for each sent instruction, so a listed instruction is not a match by its presence.
 * The field is not named `verdict`, because the prompt uses that word for the classification.
 */
const STANDING_SCOPE_DECISIONS = [
  "matched",
  "not_matched",
] as const satisfies readonly StandingInstructionScopeResult["state"][];

/**
 * The model's answer for one instruction. `reason` comes before `decision`, so the model writes
 * its reason first and decides from it. `decision` and `covers` are optional and tolerant, so
 * one missing or bad value cannot fail the whole classification: a missing or bad decision reads
 * as no answer (`unknown`), never as `matched`. A missing or bad `covers` reads as `part` (E2). The
 * `.catch` does not change the JSON schema that the model sees, so the model sees the decision
 * enum.
 */
export const triageInstructionMatchOutputSchema = z.object({
  id: z.string(),
  reason: z.string(),
  decision: z.enum(STANDING_SCOPE_DECISIONS).optional().catch(undefined),
  covers: z.string().optional().catch(undefined),
});

export type TriageInstructionMatchOutput = z.infer<typeof triageInstructionMatchOutputSchema>;

/** The E3 counter. Counts are of the scoped candidates before the allowance. */
export interface StandingScopeCounter {
  /** Candidates with a scope and no sender filter. */
  classOnly: number;
  /** Candidates whose sender filter hit this sender. */
  keyed: number;
  /** The estimated tokens of the class-only candidates' prompt lines. 0 when none. */
  classOnlyTokens: number;
  /** Candidates past the allowance. Their state is `unknown`. */
  overflow: number;
}

export interface StandingScopeBlock {
  /** The instructions in the prompt, in prompt order. */
  sent: ActiveStandingInstruction[];
  /** The prompt section, or null when no scoped instruction goes to the model. */
  section: string | null;
  counter: StandingScopeCounter;
}

/** The scoped instructions that fit the allowance, in prompt order, with their prompt lines. */
export interface StandingScopeFit {
  sent: ActiveStandingInstruction[];
  lines: string[];
}

function renderInstruction(instruction: ActiveStandingInstruction): string {
  // One line each, so a value cannot forge a `===` section.
  const scope = collapseWhitespace(instruction.value.scope ?? "");
  const phrasing = collapseWhitespace(instruction.value.phrasing);

  return `- id=${instruction.value.instructionId} | scope: ${scope} | the user's words: ${phrasing}`;
}

export const STANDING_SCOPE_SECTION_HEADER =
  "=== The user's standing instructions with a scope ===";

/**
 * The match rules that the classify call and the re-match job share. `lead` opens the entry
 * rule. `verdict` names the verdict that the `covers` rule reads.
 */
export function standingScopeMatchRules(args: { lead: string; verdict: string }): string[] {
  return [
    `${args.lead} each listed instruction, add one entry to \`instructionMatches\`: \`id\` (copied exactly), \`reason\` (one short line, under 20 words), \`decision\`, and \`covers\`. Write an entry for every instruction, also for one that does not fit.`,
    `\`decision\` is "matched" only when this email is inside the instruction's scope. Else it is "not_matched". Read each scope on its own. Write the reason first, then the decision that it supports. A reason that says the email is outside the scope needs "not_matched".`,
    `\`covers\` applies only to a "matched" decision. It is "all" when every reason for a demand in ${args.verdict} is inside the scope. It is "part" when the email also holds a reason for a demand that the scope does not cover. If you are not sure, write "part".`,
  ];
}

const SECTION_RULES = [
  "Classify the email on its own evidence, as if these instructions did not exist. Alfred applies them in code after your answer, so do not change the category, the todo, or the ask for them.",
  ...standingScopeMatchRules({ lead: "Then, for", verdict: "your own verdict" }),
];

/**
 * The scoped instructions that fit the allowance, newest first, each with its prompt line.
 * The count limit keeps the match list inside the output allowance. A candidate past either
 * limit is left out; its state stays `unknown`. The classify call and the re-match job share it.
 */
export function fitStandingScopeInstructions(
  scoped: readonly ActiveStandingInstruction[],
): StandingScopeFit {
  const newestFirst = [...scoped].sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());

  const sent: ActiveStandingInstruction[] = [];
  const lines: string[] = [];
  let chars = 0;

  for (const instruction of newestFirst) {
    if (sent.length >= TRIAGE_INSTRUCTION_MATCH_MAX_ENTRIES) break;

    const line = renderInstruction(instruction);

    if (chars + line.length + 1 > TRIAGE_INSTRUCTION_BLOCK_MAX_CHARS) continue;

    chars += line.length + 1;
    sent.push(instruction);
    lines.push(line);
  }

  return { sent, lines };
}

/**
 * Pick the scoped candidates that fit the allowance and render the section. The count limit
 * keeps the match list inside the output allowance, so a full list cannot cut the
 * classification. A candidate past either limit is counted.
 */
export function buildStandingScopeBlock(
  standing: MailStandingInstructions | null,
): StandingScopeBlock {
  const scoped = standing?.kind === "loaded" ? standing.scoped : [];

  const classOnly = scoped.filter((instruction) => instruction.value.senderFilter === undefined);

  const { sent, lines } = fitStandingScopeInstructions(scoped);

  const section =
    sent.length > 0 ? [STANDING_SCOPE_SECTION_HEADER, ...SECTION_RULES, ...lines].join("\n") : null;

  return {
    sent,
    section,
    counter: {
      classOnly: classOnly.length,
      keyed: scoped.length - classOnly.length,
      classOnlyTokens:
        classOnly.length === 0 ? 0 : estimateTokens(classOnly.map(renderInstruction).join("\n")),
      overflow: scoped.length - sent.length,
    },
  };
}

export interface StandingScopeMatchRead {
  /**
   * One result for each sent instruction that the model decided, for `instruction_evaluation`.
   * A sent instruction with no result stays `unknown`.
   */
  scopes: StandingInstructionScopeResult[];
  /** The `matched` results, for the instruction floor. */
  matches: StandingInstructionMatch[];
}

/**
 * The model's decisions as scope results for the sent instructions. Only an explicit `matched`
 * decision makes a match, so a listed instruction is not a match by its presence. An explicit
 * `not_matched` decision is `not_matched`. A sent instruction with no decision, a bad decision,
 * or two entries that disagree has no result, so it stays `unknown`. An id that was not sent
 * matches nothing. When the model left out the whole list, each instruction stays `unknown`.
 */
export function readStandingScopeMatches(
  sent: readonly ActiveStandingInstruction[],
  output: readonly TriageInstructionMatchOutput[] | undefined,
): StandingScopeMatchRead {
  if (output === undefined) return { scopes: [], matches: [] };

  // An id with two entries that disagree on the decision maps to null: the model gave no one
  // answer. Two `matched` entries that disagree on `covers` read as `part`, the narrower cover (E2).
  const byId = new Map<string, TriageInstructionMatchOutput | null>();

  for (const entry of output) {
    const id = entry.id.trim();
    const seen = byId.get(id);

    if (seen === undefined) byId.set(id, entry);
    else if (seen === null) continue;
    else if (seen.decision !== entry.decision) byId.set(id, null);
    else if (seen.covers !== entry.covers) byId.set(id, { ...seen, covers: "part" });
  }

  const scopes: StandingInstructionScopeResult[] = [];
  const matches: StandingInstructionMatch[] = [];

  for (const instruction of sent) {
    const { instructionId, revision } = instruction.value;
    const entry = byId.get(instructionId);

    if (!entry?.decision) continue;

    if (entry.decision === "not_matched") {
      scopes.push({ state: "not_matched", instructionId, revision });
      continue;
    }

    // Strips null bytes for jsonb and caps the length without a split surrogate pair.
    const reason = sanitizeErrorMessage(
      collapseWhitespace(entry.reason),
      TRIAGE_INSTRUCTION_MATCH_REASON_MAX_CHARS,
    );

    const covers = standingInstructionCoverageSchema.parse(entry.covers?.trim().toLowerCase());

    scopes.push({ state: "matched", instructionId, revision, reason, covers });
    matches.push({ ...instruction, via: { kind: "scope", reason, covers } });
  }

  return { scopes, matches };
}
