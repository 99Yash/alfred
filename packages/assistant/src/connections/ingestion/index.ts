/**
 * Provider ingestion coordination: the `ingestion-runs` BullMQ queue, its worker
 * lifecycle, the boot-time repeatable schedules, and the per-provider handler
 * registrations the composition layer wires in.
 *
 * This barrel is the door product code should use. It withholds the raw
 * per-credential Gmail entry points on purpose — those bypass the job that owns
 * retry, burst dedup and cursor bookkeeping — and operational scripts reach them
 * through the explicit friend door `./internal` instead.
 *
 * Two other kinds of door exist next to it, and neither is permanent. `./internal`
 * is the privileged friend door described above. The manifest also carries four
 * transitional leaf keys (`./connections/ingestion/{queue,chat-media,gmail-triage,
 * gmail-user-model}`) that exist only so the four `packages/api/test/integrations/`
 * tests can reach a subject whose composition half still lives in
 * `packages/api/src/composition/`; campaign item 09 dissolves that directory, moves
 * those tests, and deletes the four keys with them. Do not add a product consumer
 * of a leaf key.
 *
 * Importing this module evaluates `./queue`, which constructs BullMQ `Queue` and
 * `Worker` classes lazily but pulls the whole Gmail ingestion graph into the
 * importer's module graph. That is why `../oauth-state` imports the
 * `./workflow-recovery` leaf directly and why `../index` does NOT re-export this
 * barrel: the `@alfred/assistant/connections` door stays cheap for the operational
 * scripts that reach it. Both of those are conventions held by review only — see
 * the note in `../index` for what does and does not check them.
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
