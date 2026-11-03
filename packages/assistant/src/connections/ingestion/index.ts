/**
 * Ingestion door: the `ingestionQueue` handle, the `ingestionWorker` consumer with its schedules,
 * and handler registrations. Withholds the raw per-credential Gmail entry points, which bypass the job's retry,
 * dedup and cursor bookkeeping; scripts use `./internal`. Do not add leaf keys back. Importing this
 * loads the whole Gmail ingestion graph, so `../index` does not re-export it and `../oauth-state`
 * imports `./workflow-recovery` directly. Review enforces both.
 */
export {
  ingestionQueue,
  enqueueChatAttachmentEnrichment,
  enqueueChatStorageCleanup,
  enqueueGmailKindRefold,
  enqueueTriageRelabel,
  enqueuePendingUploadCleanup,
} from "./queue";

export { ingestionWorker } from "./worker";

export {
  receiveInboundDelivery,
  type InboundDeliveryOutcome,
  type ReceiveInboundDeliveryArgs,
} from "./inbound-receive";

export { startReceiptPayloadReaper, stopReceiptPayloadReaper } from "./receipt-payload-reaper";

export { installGmailWatchAndSeedCursor } from "./gmail-ingest";

export {
  registerChatMediaHandler,
  type ChatMediaHandler,
  type ChatMediaPendingUploadCleanupRequest,
} from "./chat-media";

export {
  captureGmailObservations,
  registerGmailUserModelHandler,
  type GmailKindRefoldResult,
  type GmailUserModelHandler,
} from "./gmail-user-model";

export {
  registerGmailTriageHandler,
  runGmailPostInsertTriage,
  type GmailPostInsertTriageResult,
  type GmailTriageHandler,
  type GmailTriageRelabelResult,
} from "./gmail-triage";

export {
  registerWorkflowRecoveryHandler,
  resolveWorkflowRecoveryTarget,
  workflowRecoveryStateSchema,
  type WorkflowRecoveryResult,
} from "./workflow-recovery";
