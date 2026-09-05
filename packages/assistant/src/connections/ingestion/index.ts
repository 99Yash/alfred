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
 * One other door exists next to it, and it is not permanent: `./internal`, the
 * privileged friend door described above. The manifest used to carry four
 * transitional leaf keys as well, because the tests that drove these registrations
 * lived in `packages/api/test/` while the adapters that satisfy them lived in
 * `packages/api/src/composition/`. Campaign item 09 moved the adapters to
 * `packages/assistant/src/runtime/adapters/` and those five suites to
 * `packages/assistant/test/runtime/`, so the tests now reach the leaves relatively
 * and the four keys are gone. Do not add a leaf key back.
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
  enqueueInboundDelivery,
  enqueueTriageRelabel,
  enqueuePendingUploadCleanup,
  getIngestionQueue,
} from "./queue";
export type { IngestionJobData } from "./queue";
export { scheduleRepeatableIngestionJobs } from "./repeatable";
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
