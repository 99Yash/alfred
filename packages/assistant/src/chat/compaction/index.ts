/**
 * The rolling `<conversation_summary>` (watermark plus CAS), context assembly, and
 * background compaction. Not `execution/run-compaction`; they share only token math.
 */
export { loadChatThreadContext } from "./chat-context-store";

export { type ChatMessageWatermark } from "./chat-message-watermark";

export { assembleChatContext } from "./chat-context-assembly";

export { estimateChatRequestTokens } from "./chat-request-pressure";

export { CHAT_MAX_OUTPUT_TOKENS, CHAT_SYNC_COMPACTION_RATIO } from "./constants";

export {
  closeConversationCompactionQueue,
  startConversationCompactionWorker,
  stopConversationCompactionWorker,
} from "./conversation-compaction-queue";

export {
  backgroundCompactionThresholdTokens,
  scheduleConversationCompactionIfNeeded,
} from "./conversation-compaction-scheduler";

export { guardTurnContext, withEphemeralReference } from "./turn-context-guard";
