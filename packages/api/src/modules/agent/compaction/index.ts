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
export {
  assertHandoffSections,
  extractHandoffSection,
  HANDOFF_SECTIONS,
  type HandoffSection,
} from "./handoff";
export { COMPACTOR_SYSTEM_PROMPT } from "./prompt";
export { CHARS_PER_TOKEN, estimateSerializedTokens, estimateTranscriptTokens } from "./tokens";

// Persisted chat compaction.
export {
  conversationSummarySchema,
  conversationSummarySourceSchema,
  parsePersistedConversationSummary,
  validateConversationSummary,
  type ConversationSummary,
  type ConversationSummarySource,
  type EligibleConversationSummarySources,
} from "./conversation-summary";
export {
  loadChatThreadContext,
  markConversationCompactionRequested,
  persistConversationSummary,
  recordConversationCompactionFailure,
  type ChatSummaryWatermark,
  type LoadedChatThreadContext,
  type PersistConversationSummaryArgs,
} from "./chat-context-store";
export {
  assembleChatContext,
  conversationSummaryMessage,
  selectVerbatimTail,
  CHAT_VERBATIM_TAIL_BUDGET_TOKENS,
  type AssembledChatContext,
  type ChatContextMessage,
} from "./chat-context-assembly";
export {
  assessChatRequestPressure,
  estimateChatRequestTokens,
  CHAT_HYDRATED_IMAGE_TOKENS,
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_SYNC_COMPACTION_RATIO,
  type ChatRequestPressure,
  type ChatRequestTokenEstimate,
} from "./chat-request-pressure";
export {
  chooseConversationSummaryModel,
  eligibleConversationSummarySources,
  generateConversationSummary,
  CONVERSATION_SUMMARY_MAX_OUTPUT_TOKENS,
  type ConversationSummaryEvidence,
  type ConversationSummaryGeneratorDependencies,
  type ConversationSummaryModelRoute,
  type GenerateConversationSummaryArgs,
} from "./conversation-summary-generator";
export {
  buildConversationSummaryEvidence,
  loadConversationSummaryEvidence,
  CONVERSATION_EVIDENCE_TEXT_LIMIT_CHARS,
  type LoadedConversationSummaryEvidence,
} from "./conversation-summary-evidence";
export {
  compactConversationSynchronously,
  type SynchronousConversationCompactionArgs,
  type SynchronousConversationCompactionDependencies,
  type SynchronousConversationCompactionResult,
} from "./synchronous-conversation-compaction";
export {
  isCompactionActive,
  waitForActiveConversationCompaction,
  FOREGROUND_COMPACTION_POLL_MS,
  FOREGROUND_COMPACTION_WAIT_MS,
  type ConversationCompactionWaitDependencies,
} from "./conversation-compaction-wait";
export {
  closeConversationCompactionQueue,
  conversationCompactionJobId,
  enqueueConversationCompaction,
  getConversationCompactionQueue,
  isUnrecoverableConversationCompactionError,
  startConversationCompactionWorker,
  stopConversationCompactionWorker,
  CONVERSATION_COMPACTION_QUEUE_NAME,
} from "./conversation-compaction-queue";
export {
  backgroundCompactionThresholdTokens,
  scheduleConversationCompactionIfNeeded,
  BACKGROUND_COMPACTION_ABSOLUTE_CAP_TOKENS,
  BACKGROUND_COMPACTION_RATIO,
} from "./conversation-compaction-scheduler";
export {
  readChatHistory,
  CHAT_HISTORY_EXCERPT_CHARS,
  CHAT_HISTORY_RESULT_LIMIT,
  type ChatHistoryRetrievalDependencies,
  type ReadChatHistoryInput,
} from "./chat-history-retrieval";
// Pre-call context guard: compaction owns its recipe, not just its ingredients.
export {
  buildCompactedChatTranscriptPair,
  guardTurnContext,
  oversizedUserMessageSummaryMessage,
  storedCompactionPrefix,
  withEphemeralReference,
} from "./turn-context-guard";
