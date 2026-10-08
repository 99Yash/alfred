/**
 * Run transcript compaction (ADR-0035): the in-run `<run_summary>`.
 * Chat's `<conversation_summary>` lives in `chat/compaction`.
 */
export {
  compactTranscript,
  type CompactTranscriptArgs,
  type CompactTranscriptResult,
} from "./compactor";

export { compactWithRetry } from "./compact-with-retry";

export {
  assertHandoffSections,
  extractHandoffSection,
  HANDOFF_SECTIONS,
  type HandoffSection,
} from "./handoff";

export { COMPACTOR_SYSTEM_PROMPT } from "./prompt";

export { CHARS_PER_TOKEN, estimateSerializedTokens, estimateTranscriptTokens } from "./tokens";
