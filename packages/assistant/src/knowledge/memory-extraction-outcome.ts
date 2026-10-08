import { z } from "zod";

/**
 * What a memory-extraction run did, as one discriminated value (#1109). Pure.
 * `proposed: 0` used to hide four different failures; each now has its own arm.
 * `documentIds` already holds the picked set, so there is no separate counter.
 */

/** The raw tallies of a finished run. `picked` is `documentIds.length`. */
export interface MemoryExtractionRunCounts {
  picked: number;
  /** Lower than `picked` when a document vanished. */
  processed: number;
  /** Loaded documents whose extractor call threw. Always `<= processed`. */
  errors: number;
  /** Proposals the gates let through. */
  proposed: number;
  /** Proposals a dedup or rejection guard stopped. */
  blocked: number;
}

/**
 * Parse for an outcome read back from `agent_runs.output` (jsonb). The type is
 * `z.infer` of this schema: `satisfies z.ZodType` would not catch a missing arm.
 */
export const memoryExtractionOutcomeSchema = z.discriminatedUnion("kind", [
  /** The pick window was empty; the extractor never ran. */
  z.object({ kind: z.literal("no_documents_picked") }),
  /** Every picked document failed to load. */
  z.object({ kind: z.literal("picked_none_readable"), picked: z.number().int().nonnegative() }),
  /** Every loaded document threw. The fix is the extractor, not the rubric. */
  z.object({
    kind: z.literal("extraction_failed"),
    picked: z.number().int().nonnegative(),
    /** Also the error count. */
    processed: z.number().int().nonnegative(),
  }),
  /** The extractor returned nothing worth proposing. */
  z.object({
    kind: z.literal("no_facts_proposed"),
    picked: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    /** Fewer than `processed`; `errors === processed` is `extraction_failed`. */
    errors: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  /** Healthy. `errors` can be non-zero on a partial failure. */
  z.object({
    kind: z.literal("facts_proposed"),
    picked: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    proposed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
]);

/** Each arm carries only the counts it can meaningfully report. */
export type MemoryExtractionOutcome = z.infer<typeof memoryExtractionOutcomeSchema>;

/** The one mint. Callers pass tallies; this picks the arm. */
export function summarizeMemoryExtractionRun(
  counts: MemoryExtractionRunCounts,
): MemoryExtractionOutcome {
  const { picked, processed, errors, proposed, blocked } = counts;

  if (picked === 0) return { kind: "no_documents_picked" };

  // Usually the documents were deleted between pick and read.
  if (processed === 0) return { kind: "picked_none_readable", picked };

  // A throwing document proposes nothing, so this check before `proposed` is safe.
  if (errors >= processed) return { kind: "extraction_failed", picked, processed };

  if (proposed === 0) return { kind: "no_facts_proposed", picked, processed, errors, blocked };

  return { kind: "facts_proposed", picked, processed, errors, proposed, blocked };
}

/** `; 2 of 7 document(s) threw inside the extractor`, or nothing when none did. */
function describeErrors(errors: number, processed: number): string {
  if (errors === 0) return "";

  return `; ${errors} of ${processed} document(s) threw inside the extractor`;
}

/** One fragment per arm, for the `extraction_run` chunk and the step log. */
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
