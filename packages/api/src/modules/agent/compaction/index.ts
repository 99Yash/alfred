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
  persistConversationSummary,
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
