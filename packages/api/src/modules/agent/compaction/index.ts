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
export {
  assertHandoffSections,
  extractHandoffSection,
  HANDOFF_SECTIONS,
  type HandoffSection,
} from "./handoff";
export { COMPACTOR_SYSTEM_PROMPT } from "./prompt";
export { estimateTranscriptTokens } from "./tokens";
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
  eligibleConversationSummarySources,
  generateConversationSummary,
  CONVERSATION_SUMMARY_MAX_OUTPUT_TOKENS,
  type ConversationSummaryEvidence,
  type GenerateConversationSummaryArgs,
} from "./conversation-summary-generator";
