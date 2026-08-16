/**
 * Chat compaction and context assembly, owned by `chat`. This is the
 * persisted, rolling `<conversation_summary>` mechanism — guarded by a compound
 * watermark and CAS — plus the pre-call context assembly and the background
 * compaction queue/scheduler/wait it drives. It is distinct from the generic
 * run compaction in `agent/run-compaction`; the two share only token math, which
 * these files reach through the `agent` public seam.
 *
 * The chat recipe (`../chat-turn.ts`, `../chat-turn-closure.ts`) reaches chat
 * context through this internal barrel, not through `../../agent`.
 */
export { type ConversationSummary } from "./conversation-summary";
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
// Pre-call context guard: compaction owns its recipe, not just its ingredients.
export {
  buildCompactedChatTranscriptPair,
  guardTurnContext,
  oversizedUserMessageSummaryMessage,
  storedCompactionPrefix,
  withEphemeralReference,
} from "./turn-context-guard";
