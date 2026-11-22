import { collapseWhitespace, type IanaTimezone } from "@alfred/contracts";
import { inZone } from "@alfred/assistant/time";
import {
  listActiveStandingInstructions,
  type ActiveStandingInstruction,
} from "./standing-instructions";

/**
 * The user's standing instructions in his own words (ADR-0121 decision 7, triage slice 4a).
 * Code does not match an instruction to mail and applies no effect. The model reads the words
 * as evidence, with their dates, oldest first.
 */

/** One instruction in the user's words, and the date of its first active row. */
export interface InstructionInWords {
  words: string;
  since: Date;
}

/** A failed read is not "none": the trace must tell the two apart. */
export type InstructionsInWordsRead =
  | { kind: "loaded"; instructions: InstructionInWords[] }
  | { kind: "read_failed"; error: unknown };

/**
 * One entry for each different text, oldest first. The text is the user's `phrasing`, or the
 * `directive` when the phrasing is empty. Rows with the same text (whitespace and case ignored)
 * are one instruction, with the date of the earliest row. One chat sentence that capture stored
 * as many sender rows thus reads as the one sentence that the user said.
 */
export function instructionsInWordsOf(
  active: readonly ActiveStandingInstruction[],
): InstructionInWords[] {
  const byWords = new Map<string, InstructionInWords>();

  const oldestFirst = active.toSorted((a, b) => a.validFrom.getTime() - b.validFrom.getTime());

  for (const instruction of oldestFirst) {
    const words =
      collapseWhitespace(instruction.value.phrasing) ||
      collapseWhitespace(instruction.value.directive);

    if (!words) continue;

    const key = words.toLowerCase();

    if (!byWords.has(key)) byWords.set(key, { words, since: instruction.validFrom });
  }

  return [...byWords.values()];
}

/** Every active instruction in words. It never throws: a failed read is `read_failed`. */
export async function readInstructionsInWords(userId: string): Promise<InstructionsInWordsRead> {
  try {
    return {
      kind: "loaded",
      instructions: instructionsInWordsOf(await listActiveStandingInstructions(userId)),
    };
  } catch (error) {
    return { kind: "read_failed", error };
  }
}

export interface RenderedInstructionsInWords {
  /** The header and one line for each sent instruction. Null when none is sent. */
  section: string | null;
  sent: number;
  /** Instructions left out because the section is over `maxChars`. */
  omitted: number;
}

/**
 * The prompt section that triage and the briefing composer share: the header, then one line for
 * each instruction, `- YYYY-MM-DD: <words>`, oldest first, with the date in the user's zone.
 * One line each, so a value cannot forge a `===` section. When the lines are over `maxChars`,
 * the newest that fit are kept, because a newer instruction wins over an older one.
 */
export function renderInstructionsInWords(args: {
  instructions: readonly InstructionInWords[];
  header: string;
  timezone: IanaTimezone;
  maxChars: number;
}): RenderedInstructionsInWords {
  const zone = inZone(args.timezone);
  const kept: string[] = [];
  let chars = 0;

  for (const instruction of args.instructions.toReversed()) {
    const line = `- ${zone.day(instruction.since)}: ${collapseWhitespace(instruction.words)}`;

    if (chars + line.length + 1 > args.maxChars) continue;

    chars += line.length + 1;
    kept.push(line);
  }

  const omitted = args.instructions.length - kept.length;

  if (kept.length === 0) return { section: null, sent: 0, omitted };

  return { section: [args.header, ...kept.toReversed()].join("\n"), sent: kept.length, omitted };
}
