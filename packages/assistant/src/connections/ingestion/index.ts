/**
 * Provider ingestion coordination: the `ingestion-runs` BullMQ queue, its worker
 * lifecycle, the boot-time repeatable schedules, and the per-provider handler
 * registrations the composition layer wires in.
 *
 * This barrel is the one supported door. It withholds the raw per-credential Gmail
 * entry points on purpose — those bypass the job that owns retry, burst dedup and
 * cursor bookkeeping — and operational scripts reach them through the explicit
 * friend door `./internal` instead.
 *
 * Importing this module evaluates `./queue`, which constructs BullMQ `Queue` and
 * `Worker` classes lazily but pulls the whole Gmail ingestion graph into the
 * importer's module graph. That is why `../oauth-state` imports the
 * `./workflow-recovery` leaf directly and why `../index` does NOT re-export this
 * barrel: the `@alfred/assistant/connections` door stays cheap for its ~51
 * operational-script consumers.
 */
export {
  startIngestionWorker,
  stopIngestionWorker,
  closeIngestionQueue,
  enqueueChatAttachmentEnrichment,
  enqueueChatStorageCleanup,
  enqueueGmailKindRefold,
  enqueueTriageRelabel,
  enqueuePendingUploadCleanup,
  getIngestionQueue,
} from "./queue";
export type { IngestionJobData } from "./queue";
export { scheduleRepeatableIngestionJobs } from "./repeatable";
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
