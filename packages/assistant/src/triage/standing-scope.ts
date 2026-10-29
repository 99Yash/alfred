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
 * The model's answer for one instruction. `covers` is an optional free string, so that one
 * missing or bad value cannot fail the whole classification. A value of another type (`null`,
 * a number) also reads as missing, and the parse reads every such value as `part` (E2). The
 * `.catch` does not change the JSON schema that the model sees.
 */
export const triageInstructionMatchOutputSchema = z.object({
  id: z.string(),
  reason: z.string(),
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
    `${args.lead} each instruction whose scope this email is about, add one entry to \`instructionMatches\`: \`id\` (copied exactly), \`reason\` (one short line, under 20 words), and \`covers\`. Leave out every instruction whose scope does not fit. An empty list is a normal answer.`,
    `\`covers\` is "all" when every reason for a demand in ${args.verdict} is inside the scope. It is "part" when the email also holds a reason for a demand that the scope does not cover. If you are not sure, write "part".`,
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
  /** One result for each sent instruction, for `instruction_evaluation`. */
  scopes: StandingInstructionScopeResult[];
  /** The `matched` results, for the instruction floor. */
  matches: StandingInstructionMatch[];
}

/**
 * The model's matches as scope results for every sent instruction. An id that was not sent
 * matches nothing. A sent instruction that the model did not list is `not_matched`. When the
 * model left out the whole list, no instruction has a result, so each stays `unknown`.
 */
export function readStandingScopeMatches(
  sent: readonly ActiveStandingInstruction[],
  output: readonly TriageInstructionMatchOutput[] | undefined,
): StandingScopeMatchRead {
  if (output === undefined) return { scopes: [], matches: [] };

  const byId = new Map<string, TriageInstructionMatchOutput>();

  for (const entry of output) {
    const id = entry.id.trim();

    if (!byId.has(id)) byId.set(id, entry);
  }

  const scopes: StandingInstructionScopeResult[] = [];
  const matches: StandingInstructionMatch[] = [];

  for (const instruction of sent) {
    const { instructionId, revision } = instruction.value;
    const entry = byId.get(instructionId);

    if (!entry) {
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
