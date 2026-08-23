// Public seam for the chat module. Owns the chat recipe (chatTurnWorkflow),
// turn admission and attachment ingest, chat context assembly + summaries +
// compaction, and the end-of-thread idle-capture trigger.
//
// The chat HTTP routes live in `packages/http/src/chat.ts` and hold
// transport only, so every decision a chat send takes reaches them through this
// seam. Four entry points carry those decisions — `startChatTurn`,
// `stopChatTurn`, `uploadChatAttachment`, `resolveChatAttachmentContentUrl`.
// The storage, quota and dedup helpers under them are module-private on
// purpose: a caller that reaches past these four takes a decision this module
// owns.

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
