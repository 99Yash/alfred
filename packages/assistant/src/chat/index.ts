// Public seam for chat. The HTTP routes in `packages/http/src/chat.ts` are transport only:
// they call `startChatTurn`, `stopChatTurn`, `uploadChatAttachment`, and `resolveChatAttachmentContentUrl`.

export { chatTurnWorkflow } from "./chat-turn";

export { startChatTurn, stopChatTurn } from "./turn-admission";

export { resolveChatAttachmentContentUrl, uploadChatAttachment } from "./attachment-ingest";

export {
  backgroundCompactionThresholdTokens,
  closeConversationCompactionQueue,
  scheduleConversationCompactionIfNeeded,
  startConversationCompactionWorker,
  stopConversationCompactionWorker,
} from "./compaction";

export { CHAT_MAX_OUTPUT_TOKENS } from "./compaction/constants";

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

export {
  claimChatAttachmentEnrichment,
  enrichClaimedChatAttachment,
  recordChatAttachmentEnrichmentFailure,
} from "./attachments/attachment-enrichment";

export {
  attachmentObjectKeys,
  deleteObjects,
  deletePrefix,
  isStorageConfigured,
  pdfDegradedArtifactKey,
} from "./attachments/storage";

export { lockChatStorageKeys, withChatStorageKeyLock } from "./attachments/storage-coordination";

export { registerChatSystemToolAdapter } from "./system-tool-adapter";
