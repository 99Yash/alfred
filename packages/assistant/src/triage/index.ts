/** Email triage (ADR-0025 #1). Terms: `docs/reference/glossary.md`. */

export { classifyEmail, triageClassificationSchema, DEFAULT_TRIAGE_CATEGORY } from "./classify";

export { applyFloors } from "./floors";

export type {
  TriageClassification,
  ClassifyEmailArgs,
  TriageConflict,
  ClassifyAudit,
  RunPass,
} from "./classify";

export {
  getDocumentAuthoredAt,
  getTriage,
  loadTriageContext,
  markGmailDocumentSent,
  parseTriageEvaluationColumns,
  setAppliedLabelId,
  triageThreadLockKey,
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

export { extractSenderContext, recipientAddresses } from "../knowledge";

export type { ExtractSenderContextArgs, SenderContextResult } from "../knowledge";

export { getThreadState, readGmailThreadClosure } from "./thread-state";

export type { ThreadState, GetThreadStateArgs, GmailThreadClosure } from "./thread-state";

export { gmailSentSql, notSentGmailDocumentWhere } from "./sent-mail";

export { TRIAGE_OUT_OF_SCOPE_MEANING, triageOutOfScope, type TriageOutOfScope } from "./scope";

// The parser port knowledge depends on (ADR-0089).
export { gmailSenderAdapter } from "./gmail-sender-adapter";

export { assembleObservations, extractGmailSignals, extractContentFlags } from "./observations";

export type {
  Observations,
  GmailSignals,
  ContentFlags,
  AssembleObservationsArgs,
} from "./observations";

export { decideTriageTodo } from "./todo-decision";

export type { TriageTodoDecision } from "./todo-decision";

export {
  gatherObservations,
  loadStoredTriageClassifyInput,
  runEmailTriageApplyLabel,
  runEmailTriageClassify,
  type EmailTriageOperationState,
} from "./workflow-operations";

// Registered by the composition root.
export { emailTriageWorkflow } from "./email-triage";

// The backfill reads the triage coverage of each message with it.
export { readTriageVerdicts } from "./email-triage";

export {
  appendMailObjectLink,
  proposeMailObjectLinks,
  proposeMailObjectLinksBatch,
} from "./object-links";

export type {
  MailObjectLinkDocument,
  MailObjectLinkInput,
  MailObjectLinkProposal,
} from "./object-links";
