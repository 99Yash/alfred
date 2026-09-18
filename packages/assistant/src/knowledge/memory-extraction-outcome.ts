import { z } from "zod";

/**
 * What a memory-extraction run actually did, as ONE discriminated value.
 *
 * Pure: no IO, no model, no database. `workflow-operations.ts` owns the counting;
 * this file owns the naming.
 *
 * The defect this closes (#1109): a run that reported `proposed: 0` said nothing
 * about WHICH zero it meant. "The pick window returned no documents", "documents
 * were picked but none survived to the read", "every read document threw inside
 * the extractor" and "documents were read and the extractor returned nothing"
 * are four different bugs with four different fixes, and all four printed the
 * same sentence. Ten of the first eleven production runs reported that sentence,
 * so the number that decides the fix was never in the report.
 *
 * The force is the union, not a counter: `picked` is a REQUIRED member of four
 * of the five arms, so a report cannot omit it, and `describeMemoryExtractionOutcome`
 * switches exhaustively, so a sixth arm without a sentence fails `check-types`.
 * No `picked` field is added to the workflow state — `documentIds` already holds
 * the picked set and survives every step, so a second counter would be a copy of
 * a number the state owns, free to drift.
 */

/** The five raw tallies a finished run holds. `picked` is `documentIds.length`. */
export interface MemoryExtractionRunCounts {
  /** Documents the pick step selected. */
  picked: number;
  /** Documents the process step actually loaded. Lower than `picked` when a document vanished. */
  processed: number;
  /**
   * Loaded documents whose extractor call THREW. Always `<= processed`: the
   * throw happens after the load, and the loop counts the document either way.
   * A throwing extractor proposes nothing, so a run with `errors === processed`
   * cannot have proposed a fact.
   */
  errors: number;
  /** Facts the extractor proposed and the gates let through. */
  proposed: number;
  /** Proposals a dedup or rejection guard suppressed. */
  blocked: number;
}

/**
 * Runtime parse for an outcome read back OUT of storage — `agent_runs.output` is
 * `jsonb`, so a reader gets `unknown` and must validate at its own boundary
 * rather than cast.
 *
 * The schema is the SOURCE OF TRUTH and {@link MemoryExtractionOutcome} is
 * `z.infer` of it, the pattern `packages/contracts/src/workflow-run.ts` uses and
 * §1 of `code-style.md` names as the default. A hand-written parallel type with
 * `satisfies z.ZodType<…>` does NOT hold the two together: `ZodType` is
 * covariant in its output parameter, so a schema that omits a whole arm still
 * compiles clean. Deriving the type is the only direction that cannot drift.
 */
export const memoryExtractionOutcomeSchema = z.discriminatedUnion("kind", [
  /** The pick window returned nothing, so the extractor never ran. */
  z.object({ kind: z.literal("no_documents_picked") }),
  /** Documents were picked and every one of them failed to load. */
  z.object({ kind: z.literal("picked_none_readable"), picked: z.number().int().nonnegative() }),
  /**
   * Every document that loaded threw inside the extractor. Distinct from
   * `no_facts_proposed` because the fix is the extractor, not the rubric —
   * these two reported the same bytes before #1109.
   */
  z.object({
    kind: z.literal("extraction_failed"),
    picked: z.number().int().nonnegative(),
    /** Also the error count: every processed document threw. */
    processed: z.number().int().nonnegative(),
  }),
  /** Documents were read and the extractor returned no fact worth proposing. */
  z.object({
    kind: z.literal("no_facts_proposed"),
    picked: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    /** Strictly fewer than `processed`; `errors === processed` is `extraction_failed`. */
    errors: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  /** The healthy path. `errors` can still be non-zero on a partial failure. */
  z.object({
    kind: z.literal("facts_proposed"),
    picked: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    proposed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
]);

/**
 * Which of the five mutually exclusive things a run did. Each arm carries only
 * the counts that arm can meaningfully report: a run that picked nothing has no
 * processed, proposed or blocked count worth stating.
 */
export type MemoryExtractionOutcome = z.infer<typeof memoryExtractionOutcomeSchema>;

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
  const { picked, processed, errors, proposed, blocked } = counts;

  if (picked === 0) return { kind: "no_documents_picked" };

  // Picked, then every one of them failed to load. Today that means the
  // documents were deleted between the pick and the read; it has never been
  // reported because nothing distinguished it from an empty pick.
  if (processed === 0) return { kind: "picked_none_readable", picked };

  // Every document that loaded threw inside the extractor. Checked BEFORE the
  // proposed test, and safely so: a throwing document proposes nothing, so
  // `errors === processed` implies `proposed === 0`. Without this arm the run
  // reported `no_facts_proposed`, which points the reader at the extraction
  // rubric — the one place the fix is not.
  if (errors >= processed) return { kind: "extraction_failed", picked, processed };

  if (proposed === 0) return { kind: "no_facts_proposed", picked, processed, errors, blocked };

  return { kind: "facts_proposed", picked, processed, errors, proposed, blocked };
}

/** `; 2 of 7 document(s) threw inside the extractor`, or nothing when none did. */
function describeErrors(errors: number, processed: number): string {
  if (errors === 0) return "";

  return `; ${errors} of ${processed} document(s) threw inside the extractor`;
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

    case "extraction_failed":
      return (
        `picked ${outcome.picked} document(s); read ${outcome.processed}; ` +
        `the extractor threw for every one of them, so no fact could be proposed`
      );

    case "no_facts_proposed":
      return (
        `picked ${outcome.picked} document(s); read ${outcome.processed}; ` +
        `proposed 0 fact(s); ${outcome.blocked} suppressed by dedup/rejection guards` +
        describeErrors(outcome.errors, outcome.processed)
      );

    case "facts_proposed":
      return (
        `picked ${outcome.picked} document(s); read ${outcome.processed}; ` +
        `proposed ${outcome.proposed} fact(s); ` +
        `${outcome.blocked} suppressed by dedup/rejection guards` +
        describeErrors(outcome.errors, outcome.processed)
      );

    default: {
      const unreachable: never = outcome;

      return unreachable;
    }
  }
}
