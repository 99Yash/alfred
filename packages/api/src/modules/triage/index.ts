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
  triageClassificationSchema,
  DEFAULT_TRIAGE_CATEGORY,
} from "./classify";
export type {
  TriageClassification,
  ClassifyEmailArgs,
  TriageConflict,
  ClassifyAudit,
  ResolvedTodoSuggestion,
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
  upsertTriage,
} from "./store";
export type { TriageRow, UpsertTriageArgs, TriageDocumentContext } from "./store";

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
