/**
 * Transcript compaction primitive (ADR-0035).
 *
 * The `compact-transcript` executor step in `userAuthoredBriefWorkflow`
 * is the only call site today. The function is shaped as a reusable
 * primitive so the post-m13 chat surface (and any future long-running
 * agent driver) can import it without rework — the boss workflow holds
 * the policy (when to compact, how to retry); this module holds the
 * mechanism (one cheap-tier LLM round-trip that returns a
 * `<run_summary>`-prefixed transcript).
 */
export {
  compactTranscript,
  type CompactTranscriptArgs,
  type CompactTranscriptResult,
} from "./compactor";
export { COMPACTOR_SYSTEM_PROMPT } from "./prompt";
