import { COMPACTION_THRESHOLD_PCT } from "@alfred/contracts";

/** The absolute ceiling, so a huge model window cannot defer compaction forever. */
const BACKGROUND_COMPACTION_ABSOLUTE_CAP_TOKENS = 200_000;

/**
 * The replay-token estimate at which background compaction starts: a fraction of the
 * effective input window, capped at an absolute ceiling.
 */
export function backgroundCompactionThresholdTokens(effectiveInputWindowTokens: number): number {
  if (!Number.isFinite(effectiveInputWindowTokens) || effectiveInputWindowTokens < 0) {
    throw new Error("effectiveInputWindowTokens must be non-negative");
  }

  return Math.min(
    Math.floor(effectiveInputWindowTokens * COMPACTION_THRESHOLD_PCT),
    BACKGROUND_COMPACTION_ABSOLUTE_CAP_TOKENS,
  );
}
