/** Email triage (ADR-0025 #1). Terms: `docs/reference/glossary.md`. */

export {
  classifyEmail,
  detectConflict,
  resolveTodoSuggestion,
  todoSuppressionReason,
  triageClassificationSchema,
  DEFAULT_TRIAGE_CATEGORY,
} from "./classify";

export { applyFloors, applyOverrideFloor, standingInstructionEvidence } from "./floors";

export { deriveEffectiveTriage, standingBlockWaitsOn } from "./effective";

export type { EffectiveTriage, EffectiveTriageRow, StandingBlockEffectKind } from "./effective";

export type { StandingEffectVerdict, StandingInstructionMatch } from "./floors";

export type {
  AssistDateAnchor,
  TriageClassification,
  ClassifyEmailArgs,
  TriageConflict,
  ClassifyAudit,
  ResolvedTodoSuggestion,
  TodoSuppressionReason,
  RunPass,
} from "./classify";
// `deepen.ts` is dormant (ADR-0051) and not re-exported; only its test imports it.

export {
  getDocumentAuthoredAt,
  getTriage,
  loadTriageContext,
  markGmailDocumentSent,
  parseTriageEvaluationColumns,
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

export { reconcileThreadLabel } from "./tags";

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

export { triageWorkflowInputSchema } from "./workflow-input";

export type { TriageWorkflowInput } from "./workflow-input";

export { extractSenderContext, recipientAddresses } from "./sender-context";

export type { ExtractSenderContextArgs, SenderContextResult } from "./sender-context";

export { getThreadState, readGmailThreadClosure } from "./thread-state";

export type { ThreadState, GetThreadStateArgs, GmailThreadClosure } from "./thread-state";

export { resolveSenderRelationship } from "./sender-relationship";

export {
  resolveSenderKind,
  senderKindSignalFromProfile,
  triageSenderKindProjectionEnabled,
  TRIAGE_SENDER_KIND_CONFIDENCE_THRESHOLD,
  TRIAGE_SENDER_KIND_FEATURE_KEY,
} from "./sender-kind";

export type { TriageSenderKindSignal } from "./sender-kind";

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

export { gmailSentSql, notSentGmailDocumentWhere } from "./sent-mail";

// The parser port knowledge depends on (ADR-0089).
export { gmailSenderAdapter } from "./gmail-sender-adapter";

export { assembleObservations, extractGmailSignals, extractContentFlags } from "./observations";

export type {
  Observations,
  GmailSignals,
  ContentFlags,
  AssembleObservationsArgs,
} from "./observations";

export { senderExtractionEvent } from "./sender-extraction-event";

export type { SenderExtractionEvent } from "./sender-extraction-event";

export { decideTriageTodo, triageTodoStanding } from "./todo-decision";

export { threadsWhereInstructionBlocksTodo } from "./instruction-todo-sweep";

export {
  closeTriageRematchQueue,
  getTriageRematchQueue,
  scheduleRepeatableTriageRematchJobs,
  startTriageRematchWorker,
  stopTriageRematchWorker,
} from "./rematch-queue";

export type { TodoTriageResult, TriageTodoDecision } from "./todo-decision";

export {
  gatherObservations,
  runEmailTriageApplyLabel,
  runEmailTriageClassify,
  type EmailTriageOperationState,
} from "./workflow-operations";

// Registered by the composition root.
export { emailTriageWorkflow } from "./email-triage";
