/**
 * Email triage (ADR-0025 #1).
 *
 * Thin module: classifier + DB store. The actual workflow steps live with
 * the rest of the built-ins under `apps/server/src/builtins/workflows/`,
 * and the trigger wiring (post-ingest enqueue) lives in the integration
 * package — they all import from here.
 */

export {
  classifyEmail,
  detectConflict,
  applyOverrideFloor,
  resolveTodoSuggestion,
  todoSuppressionReason,
  triageClassificationSchema,
  DEFAULT_TRIAGE_CATEGORY,
} from "./classify";
export type {
  TriageClassification,
  ClassifyEmailArgs,
  TriageConflict,
  ClassifyAudit,
  ResolvedTodoSuggestion,
  TodoSuppressionReason,
  RunPass,
} from "./classify";
// NOTE: `deepen.ts` is dormant — ADR-0051 removed the boss-escalation from the
// triage workflow. It is intentionally NOT re-exported (nothing imports it
// outside its own unit test); the file stays for the historical decision trail.

export {
  getDocumentAuthoredAt,
  getTriage,
  loadTriageContext,
  setAppliedLabelId,
  triageThreadLockKey,
  upsertTriage,
  withTriageThreadLock,
} from "./store";
export type {
  TriageRow,
  UpsertTriageArgs,
  UpsertTriageResult,
  TriageDocumentContext,
} from "./store";

export { reconcileThreadLabel, enqueueTriageRelabel } from "./tags";
export type { ReconcileResult, ReconcileThreadLabelArgs } from "./tags";
export {
  reconcileGmailThreads,
  findNewestLiveInboundGmailDocuments,
  planGmailThreadReconcile,
} from "./gmail-reconcile";
export type {
  ReconcileGmailThreadsArgs,
  ReconcileGmailThreadsResult,
  ReconcileStoredGmailDoc,
  GmailThreadReconcilePlan,
  LiveInboundGmailDocument,
} from "./gmail-reconcile";

export { TRIAGE_WORKFLOW_SLUG, triageWorkflowInputSchema } from "./workflow-input";
export type { TriageWorkflowInput } from "./workflow-input";

export { extractSenderContext } from "./sender-context";
export type { ExtractSenderContextArgs, SenderContextResult } from "./sender-context";
export { readTriageUserContext } from "./user-context";
export type { TriageUserContext } from "./user-context";

// ── Triage v3 (ADR-0051): sent-mail thread state + sender priors + observations
export { getThreadState } from "./thread-state";
export type { ThreadState, GetThreadStateArgs } from "./thread-state";
export { isKnownContact } from "./contacts";
export { resolveSenderRelationship } from "./sender-relationship";
export {
  getSenderPrior,
  incrementSenderPrior,
  senderPriorWriteKeyFor,
  senderKeyFor,
} from "./sender-priors";
export type {
  SenderPrior,
  IncrementSenderPriorArgs,
  SenderPriorWriteKeyArgs,
} from "./sender-priors";
export { isSentGmailMetadata, gmailSentSql, notSentGmailDocumentWhere } from "./sent-mail";
export { assembleObservations, extractGmailSignals, extractContentFlags } from "./observations";
export type {
  Observations,
  GmailSignals,
  ContentFlags,
  AssembleObservationsArgs,
} from "./observations";
