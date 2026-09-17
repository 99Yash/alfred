import { z } from "zod";

/**
 * What a memory-extraction run actually did, as ONE discriminated value.
 *
 * Pure: no IO, no model, no database. `workflow-operations.ts` owns the counting;
 * this file owns the naming.
 *
 * The defect this closes (#1109): a run that reported `proposed: 0` said nothing
 * about WHICH zero it meant. "The pick window returned no documents", "documents
 * were picked but none survived to the read", and "documents were read and the
 * extractor returned nothing" are three different bugs with three different
 * fixes, and all three printed the same sentence. Ten of the first eleven
 * production runs reported that sentence, so the number that decides the fix was
 * never in the report.
 *
 * The force is the union, not a counter: `picked` is a REQUIRED member of three
 * of the four arms, so a report cannot omit it, and `describeMemoryExtractionOutcome`
 * switches exhaustively, so a fifth arm without a sentence fails `check-types`.
 * No `picked` field is added to the workflow state — `documentIds` already holds
 * the picked set and survives every step, so a second counter would be a copy of
 * a number the state owns, free to drift.
 */

/** The four raw tallies a finished run holds. `picked` is `documentIds.length`. */
export interface MemoryExtractionRunCounts {
  /** Documents the pick step selected. */
  picked: number;
  /** Documents the process step actually loaded. Lower than `picked` when a document vanished. */
  processed: number;
  /** Facts the extractor proposed and the gates let through. */
  proposed: number;
  /** Proposals a dedup or rejection guard suppressed. */
  blocked: number;
}

/**
 * Which of the four mutually exclusive things a run did. Each arm carries only
 * the counts that arm can meaningfully report: a run that picked nothing has no
 * processed, proposed or blocked count worth stating.
 */
export type MemoryExtractionOutcome =
  | { kind: "no_documents_picked" }
  | { kind: "picked_none_readable"; picked: number }
  | { kind: "no_facts_proposed"; picked: number; processed: number; blocked: number }
  | {
      kind: "facts_proposed";
      picked: number;
      processed: number;
      proposed: number;
      blocked: number;
    };

/**
 * The single mint. Callers pass the tallies; this decides the arm.
 *
 * Nothing at compile time stops a caller from writing an arm literal by hand
 * (Tier 2, stated rather than claimed) — but nothing in this repo does, and a
 * branded arm would cost more than the drift it prevents.
 */
export function summarizeMemoryExtractionRun(
  counts: MemoryExtractionRunCounts,
): MemoryExtractionOutcome {
  const { picked, processed, proposed, blocked } = counts;

  if (picked === 0) return { kind: "no_documents_picked" };

  // Picked, then every one of them failed to load. Today that means the
  // documents were deleted between the pick and the read; it has never been
  // reported because nothing distinguished it from an empty pick.
  if (processed === 0) return { kind: "picked_none_readable", picked };

  if (proposed === 0) return { kind: "no_facts_proposed", picked, processed, blocked };

  return { kind: "facts_proposed", picked, processed, proposed, blocked };
}

/**
 * One sentence fragment per arm, for the `extraction_run` memory chunk and the
 * step log. Exhaustive: a new arm without a sentence fails `pnpm check-types` on
 * the `never` assignment below.
 */
export function describeMemoryExtractionOutcome(outcome: MemoryExtractionOutcome): string {
  switch (outcome.kind) {
    case "no_documents_picked":
      return "picked 0 document(s), so the extractor did not run";

    case "picked_none_readable":
      return (
        `picked ${outcome.picked} document(s); read 0 of them ` +
        `(every one vanished between the pick and the read), so the extractor did not run`
      );

    case "no_facts_proposed":
      return (
        `picked ${outcome.picked} document(s); read ${outcome.processed}; ` +
        `proposed 0 fact(s); ${outcome.blocked} suppressed by dedup/rejection guards`
      );

    case "facts_proposed":
      return (
        `picked ${outcome.picked} document(s); read ${outcome.processed}; ` +
        `proposed ${outcome.proposed} fact(s); ` +
        `${outcome.blocked} suppressed by dedup/rejection guards`
      );

    default: {
      const unreachable: never = outcome;

      return unreachable;
    }
  }
}

/**
 * Runtime parse for an outcome read back OUT of storage — `agent_runs.output` is
 * `jsonb`, so a reader gets `unknown` and must validate at its own boundary
 * rather than cast. The `satisfies` keeps the schema and the union one shape: a
 * new arm on the type above fails this line until the schema gains it.
 */
export const memoryExtractionOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_documents_picked") }),
  z.object({ kind: z.literal("picked_none_readable"), picked: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("no_facts_proposed"),
    picked: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("facts_proposed"),
    picked: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    proposed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
]) satisfies z.ZodType<MemoryExtractionOutcome>;
