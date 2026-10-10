/**
 * The rolling `<conversation_summary>` (watermark plus CAS), context assembly, and
 * background compaction. Not `execution/run-compaction`; they share only token math.
 */
export { type ConversationSummary } from "./conversation-summary";

export {
  loadChatThreadContext,
  persistConversationSummary,
  type LoadedChatThreadContext,
  type PersistConversationSummaryArgs,
} from "./chat-context-store";

export { type ChatMessageWatermark } from "./chat-message-watermark";

export {
  assembleChatContext,
  conversationSummaryMessage,
  selectVerbatimTail,
  type ChatContextMessage,
} from "./chat-context-assembly";

export { assessChatRequestPressure, estimateChatRequestTokens } from "./chat-request-pressure";

export {
  CHAT_HYDRATED_IMAGE_TOKENS,
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_SYNC_COMPACTION_RATIO,
} from "./constants";

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

export {
  buildCompactedChatTranscriptPair,
  guardTurnContext,
  oversizedUserMessageSummaryMessage,
  storedCompactionPrefix,
  withEphemeralReference,
} from "./turn-context-guard";
