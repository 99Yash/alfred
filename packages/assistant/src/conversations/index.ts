// Public seam for the conversations module. Owns the chat recipe (chatTurnWorkflow),
// chat context assembly + summaries + compaction, and the end-of-thread idle-capture trigger.
// HTTP routes stay in @alfred/api and import from here.

export { chatTurnWorkflow, CHAT_TURN_WORKFLOW_SLUG } from "./chat-turn";

export { requestChatStop } from "./stop-signal";

export {
  backgroundCompactionThresholdTokens,
  CHAT_MAX_OUTPUT_TOKENS,
  closeConversationCompactionQueue,
  scheduleConversationCompactionIfNeeded,
  startConversationCompactionWorker,
  stopConversationCompactionWorker,
} from "./compaction";

export {
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  CHAT_MEMORY_IDLE_MS,
  CHAT_MEMORY_QUEUE_NAME,
  chatMemoryIdleJobId,
  chatMemoryIdleTailJobId,
  chatMemoryJobDataSchema,
  closeChatMemoryQueue,
  getChatMemoryQueue,
  scheduleThreadIdleExtraction,
  startChatMemoryWorker,
  stopChatMemoryWorker,
  type ChatMemoryJobData,
} from "./idle-capture-queue";

export { chatMemoryCaptureWorkflow } from "./chat-memory-capture";

export { toAttachmentRow, writeObject, type AttachmentInput } from "./attachments";

export {
  claimChatAttachmentEnrichment,
  enrichClaimedChatAttachment,
  recordChatAttachmentEnrichmentFailure,
} from "./attachments/attachment-enrichment";

export { deleteObjects, deletePrefix, isStorageConfigured } from "./attachments/storage";

export { lockChatStorageKeys } from "./attachments/storage-coordination";

export {
  assertAttachmentBatchAllowed,
  assertPassThroughImageBytes,
  assertStoredAttachmentReady,
  assertUploadAllowed,
} from "./attachments";

export { attachmentUrl, buildAttachmentKey, copyObject, objectExists } from "./attachments/storage";

export { registerConversationsSystemToolAdapter } from "./system-tool-adapter";
