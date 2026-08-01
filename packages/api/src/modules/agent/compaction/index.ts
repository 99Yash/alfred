/**
 * Agent context compaction has two related but distinct mechanisms:
 *
 * - Run compaction (ADR-0035) produces an in-band `<run_summary>` for the
 *   boss-only `compact-transcript` workflow step.
 * - Chat compaction produces a structured, persisted, rolling
 *   `<conversation_summary>` guarded by a compound watermark and CAS.
 *
 * They intentionally share token/window math, but not summary contracts,
 * persistence, or lifecycle policy. Exports are grouped by mechanism below.
 */
// Run transcript compaction.
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
export { estimateTranscriptTokens } from "./tokens";

// Persisted chat compaction.
export { type ConversationSummary } from "./conversation-summary";
export {
  loadChatThreadContext,
  persistConversationSummary,
  type LoadedChatThreadContext,
  type PersistConversationSummaryArgs,
} from "./chat-context-store";
export {
  assembleChatContext,
  conversationSummaryMessage,
  selectVerbatimTail,
  type ChatContextMessage,
} from "./chat-context-assembly";
export {
  assessChatRequestPressure,
  estimateChatRequestTokens,
  CHAT_HYDRATED_IMAGE_TOKENS,
  CHAT_MAX_OUTPUT_TOKENS,
} from "./chat-request-pressure";
export {
  chooseConversationSummaryModel,
  eligibleConversationSummarySources,
  generateConversationSummary,
  type ConversationSummaryEvidence,
} from "./conversation-summary-generator";
export {
  buildConversationSummaryEvidence,
  loadConversationSummaryEvidence,
  CONVERSATION_EVIDENCE_TEXT_LIMIT_CHARS,
} from "./conversation-summary-evidence";
export { compactConversationSynchronously } from "./synchronous-conversation-compaction";
export {
  isCompactionActive,
  waitForActiveConversationCompaction,
} from "./conversation-compaction-wait";
export {
  closeConversationCompactionQueue,
  enqueueConversationCompaction,
  isUnrecoverableConversationCompactionError,
  startConversationCompactionWorker,
  stopConversationCompactionWorker,
} from "./conversation-compaction-queue";
export {
  backgroundCompactionThresholdTokens,
  scheduleConversationCompactionIfNeeded,
  BACKGROUND_COMPACTION_ABSOLUTE_CAP_TOKENS,
} from "./conversation-compaction-scheduler";
export { readChatHistory, CHAT_HISTORY_EXCERPT_CHARS } from "./chat-history-retrieval";
// Pre-call context guard: compaction owns its recipe, not just its ingredients.
export {
  buildCompactedChatTranscriptPair,
  guardTurnContext,
  oversizedUserMessageSummaryMessage,
  storedCompactionPrefix,
  withEphemeralReference,
} from "./turn-context-guard";
