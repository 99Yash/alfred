import {
  claimProducerSchema,
  collapseWhitespace,
  isNonEmptyString,
  readStoredStandingInstruction,
  type IanaTimezone,
  type StandingInstructionValueV2,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { userFacts } from "@alfred/db/schemas";
import { desc } from "drizzle-orm";
import { userIdentity } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import { activeStandingInstructionsWhere, instructionSaidAt } from "./sender-suppression";

/**
 * The user's standing instructions in his own words (ADR-0121 decision 7, triage slice 4a).
 * Code does not match an instruction to mail and applies no effect. The model reads the words
 * as evidence, with their dates, oldest first.
 */

/** The one mailbox an instruction is for. */
export interface InstructionMailbox {
  /** The Google account id, as `documents.account_id` stores it. */
  accountId: string;
  /** The mailbox address. Null when that mailbox is not an active connection now. */
  address: string | null;
}

/** One instruction in the user's words, and the date that the user last said it. */
export interface InstructionInWords {
  words: string;
  since: Date;
  /** The one mailbox the instruction is for. Null means every mailbox. */
  mailbox: InstructionMailbox | null;
}

/** A failed read is not "none": the trace must tell the two apart. */
export type InstructionsInWordsRead =
  | { kind: "loaded"; instructions: InstructionInWords[] }
  | { kind: "read_failed"; error: unknown };

/** One active stored row, read as v2. */
export interface InstructionRow {
  value: StandingInstructionValueV2;
  /** When the user said it (see {@link instructionSaidAt}). */
  validFrom: Date;
  /** The run that wrote the row (`producer.runId`). Null: the capture is unknown, so the row is a copy. */
  producerRunId: string | null;
}

/**
 * The one mailbox that the stored value bounds, or null for every mailbox. Capture writes one
 * `accountId` to each place (ADR-0113): the top-level `accountId` for a scope, and each target
 * and `senderFilter` entry. So the top-level value wins. Else the senders give the bound only
 * when there is at least one sender and all of them name the same mailbox. A mix of mailboxes,
 * or one sender for every mailbox, reaches every mailbox.
 */
function mailboxBoundOf(value: StandingInstructionValueV2): string | null {
  if (value.accountId !== undefined) return value.accountId;

  const senders = [...value.targets, ...(value.senderFilter ?? [])];
  const first = senders[0]?.accountId ?? null;

  if (first === null) return null;

  return senders.every((sender) => sender.accountId === first) ? first : null;
}

/** The words the model reads: the `phrasing`, else the `directive`. Empty when both are blank. */
function wordsOf(value: StandingInstructionValueV2): string {
  return collapseWhitespace(value.phrasing) || collapseWhitespace(value.directive);
}

/**
 * The key of one instruction as triage and the briefing composer read it: its mailbox bound
 * and its words, with whitespace and case ignored. Rows with one key are one instruction. Null
 * when the words are blank, so the row is not read. Forget and edit, which act on every row of
 * one instruction, must use this key too.
 */
export function instructionKeyOf(value: StandingInstructionValueV2): string | null {
  const words = wordsOf(value);

  return words ? JSON.stringify([mailboxBoundOf(value), words.toLowerCase()]) : null;
}

/**
 * The chat run that wrote the row, from `producer.runId`. Each chat save writes it, also the
 * v1 saves of 2026-09. One run is one capture: one sentence that capture stored as many sender
 * rows. Null for a row with no run, for example the backfill of issue #1229 (2026-10-16), which
 * copied rows that already existed.
 */
function captureOf(row: InstructionRow): string | null {
  return isNonEmptyString(row.producerRunId) ? row.producerRunId : null;
}

/**
 * One entry for each different text and mailbox bound, oldest first. The text is the user's
 * `phrasing`, or the `directive` when the phrasing is empty. Rows with the same text (whitespace
 * and case ignored) and the same bound are one instruction. The same words with a different
 * bound are two instructions.
 *
 * The date: rows of one capture (one chat run), and rows with no run, are copies. They keep the
 * date of the earliest row. One chat sentence that capture stored as many sender rows, and the
 * backfill copies of it, thus read as the one sentence on the day the user said it. A row from a
 * later chat run is a reaffirmation: the user said the words again. The instruction then takes
 * that row's date, so an instruction said between the two does not read as the newer one.
 *
 * `mailboxByAccountId` gives each bound its address (`userIdentity`). Without it, a bound has a
 * null address.
 */
export function instructionsInWordsOf(
  rows: readonly InstructionRow[],
  mailboxByAccountId: ReadonlyMap<string, string> = new Map(),
): InstructionInWords[] {
  const byKey = new Map<string, { instruction: InstructionInWords; captures: Set<string> }>();

  const oldestFirst = rows.toSorted((a, b) => a.validFrom.getTime() - b.validFrom.getTime());

  for (const row of oldestFirst) {
    const key = instructionKeyOf(row.value);

    if (key === null) continue;

    const accountId = mailboxBoundOf(row.value);
    const capture = captureOf(row);
    const seen = byKey.get(key);

    if (!seen) {
      byKey.set(key, {
        instruction: {
          words: wordsOf(row.value),
          since: row.validFrom,
          mailbox:
            accountId === null
              ? null
              : { accountId, address: mailboxByAccountId.get(accountId) ?? null },
        },
        captures: new Set(capture === null ? [] : [capture]),
      });

      continue;
    }

    if (capture === null || seen.captures.has(capture)) continue;

    seen.captures.add(capture);
    seen.instruction.since = row.validFrom;
  }

  // A stable sort: two instructions of one date keep the order of their first rows.
  return [...byKey.values()]
    .map((entry) => entry.instruction)
    .toSorted((a, b) => a.since.getTime() - b.since.getTime());
}

/**
 * Every active row of any stored version, read as v2, with its producer run. A row of neither shape
 * is skipped.
 */
async function readInstructionRows(userId: string): Promise<InstructionRow[]> {
  const facts = await db()
    .select({
      id: userFacts.id,
      value: userFacts.value,
      validFrom: instructionSaidAt,
      producer: userFacts.producer,
    })
    .from(userFacts)
    .where(activeStandingInstructionsWhere(userId))
    .orderBy(desc(instructionSaidAt));

  return facts.flatMap((fact): InstructionRow[] => {
    const value = readStoredStandingInstruction(fact.value, fact.id);
    const producerRunId = claimProducerSchema.safeParse(fact.producer).data?.runId ?? null;

    return value ? [{ value, validFrom: fact.validFrom, producerRunId }] : [];
  });
}

/**
 * Every active instruction in words. It never throws: a failed read is `read_failed`.
 * `forAccountId`: only the instructions for every mailbox and for this one mailbox. Triage
 * passes the account of the mail, because a word such as "this inbox" names only the mailbox
 * that the user meant. The briefing spans every mailbox, so it passes none, and each bounded
 * line names its mailbox.
 */
export async function readInstructionsInWords(
  userId: string,
  options: { forAccountId?: string } = {},
): Promise<InstructionsInWordsRead> {
  try {
    const rows = (await readInstructionRows(userId)).filter((row) => {
      const bound = mailboxBoundOf(row.value);

      return bound === null || options.forAccountId === undefined || bound === options.forAccountId;
    });

    // The addresses are one more read, so only when a row names a mailbox.
    const mailboxByAccountId = rows.some((row) => mailboxBoundOf(row.value) !== null)
      ? (await userIdentity({ userId })).mailboxByAccountId
      : undefined;

    return { kind: "loaded", instructions: instructionsInWordsOf(rows, mailboxByAccountId) };
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

/** The mailbox note of a line. Empty for an instruction for every mailbox. */
function mailboxNote(mailbox: InstructionMailbox | null): string {
  if (mailbox === null) return "";

  return mailbox.address === null
    ? " (only for one mailbox that is not active now)"
    : ` (only for mailbox ${mailbox.address})`;
}

/**
 * The prompt section that triage and the briefing composer share: the header, then one line for
 * each instruction, `- YYYY-MM-DD: <words>`, oldest first, with the date in the user's zone. An
 * instruction for one mailbox names it after the date: `- YYYY-MM-DD (only for mailbox <address>):
 * <words>`. One line each, so a value cannot forge a `===` section. When the lines are over
 * `maxChars`, the newest that fit are kept, because a newer instruction wins over an older one.
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
    const line =
      `- ${zone.day(instruction.since)}${mailboxNote(instruction.mailbox)}: ` +
      collapseWhitespace(instruction.words);

    if (chars + line.length + 1 > args.maxChars) continue;

    chars += line.length + 1;
    kept.push(line);
  }

  const omitted = args.instructions.length - kept.length;

  if (kept.length === 0) return { section: null, sent: 0, omitted };

  return { section: [args.header, ...kept.toReversed()].join("\n"), sent: kept.length, omitted };
}
