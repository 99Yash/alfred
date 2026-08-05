/**
 * Run transcript compaction (ADR-0035). This is the generic execution-runtime
 * mechanism that produces an in-band `<run_summary>` for the boss
 * `compact-transcript` workflow step. It is NOT chat compaction — the persisted,
 * rolling `<conversation_summary>` now lives in `conversations/compaction`.
 *
 * These primitives stay in `agent` because the sub-agent executor
 * (`workflows/user-authored-brief.ts`) and `backend.ts` consume them, and the
 * token/window math they expose backs both mechanisms.
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
