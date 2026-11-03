// Public seam for chat. The HTTP routes in `packages/http/src/chat.ts` are transport only:
// they call `startChatTurn`, `stopChatTurn`, `uploadChatAttachment`, and `resolveChatAttachmentContentUrl`.

export { chatTurnWorkflow } from "./chat-turn";

export { startChatTurn, stopChatTurn } from "./turn-admission";

export { resolveChatAttachmentContentUrl, uploadChatAttachment } from "./attachment-ingest";

export {
  backgroundCompactionThresholdTokens,
  conversationCompactionWorker,
  scheduleConversationCompactionIfNeeded,
} from "./compaction";

export { CHAT_MAX_OUTPUT_TOKENS } from "./compaction/constants";

export {
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  CHAT_MEMORY_IDLE_MS,
  scheduleThreadIdleExtraction,
} from "./idle-capture-queue";

export { chatMemoryWorker } from "./idle-capture-worker";

export { chatMemoryCaptureWorkflow } from "./chat-memory-capture";

export { registerChatMediaAdapter } from "./media-adapter";

export { registerChatSystemToolAdapter } from "./system-tool-adapter";
