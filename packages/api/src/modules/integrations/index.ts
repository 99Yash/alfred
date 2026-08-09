export {
  startIngestionWorker,
  stopIngestionWorker,
  closeIngestionQueue,
  enqueueChatAttachmentEnrichment,
  enqueueGmailKindRefold,
  enqueueTriageRelabel,
  enqueuePendingUploadCleanup,
  getIngestionQueue,
} from "./queue";
export type { IngestionJobData } from "./queue";
export { installGmailWatchAndSeedCursor } from "./gmail-ingest";
export {
  assertGmailPushOidcConfigured,
  isGmailPushOidcConfigError,
  pubSubOidcConfigFromEnv,
  type PubSubOidcConfig,
} from "@alfred/integrations/google";
export {
  registerChatMediaHandler,
  type ChatMediaHandler,
  type ChatMediaPendingUploadCleanupRequest,
} from "./chat-media";
export {
  registerGmailUserModelHandler,
  type GmailKindRefoldResult,
  type GmailUserModelHandler,
} from "./gmail-user-model";
export {
  registerGmailTriageHandler,
  type GmailTriageHandler,
  type GmailTriageRelabelResult,
} from "./gmail-triage";
export {
  registerWorkflowRecoveryHandler,
  resolveWorkflowRecoveryTarget,
  workflowRecoveryStateSchema,
  type WorkflowRecoveryResult,
} from "./workflow-recovery";
