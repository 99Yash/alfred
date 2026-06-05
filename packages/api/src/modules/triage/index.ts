/**
 * Email triage (ADR-0025 #1).
 *
 * Thin module: classifier + DB store. The actual workflow steps live with
 * the rest of the built-ins under `apps/server/src/builtins/workflows/`,
 * and the trigger wiring (post-ingest enqueue) lives in the integration
 * package — they all import from here.
 */

export { classifyEmail, triageClassificationSchema, DEFAULT_TRIAGE_CATEGORY } from "./classify";
export type { TriageClassification, ClassifyEmailArgs } from "./classify";
export { deepenTriageClassification, shouldDeepen, DEEPEN_REASONS } from "./deepen";
export type {
  DeepenDecision,
  DeepenMode,
  DeepenReason,
  DeepenTriageArgs,
  DeepenTriageResult,
} from "./deepen";

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
export {
  getSenderPrior,
  incrementSenderPrior,
  senderPriorWriteKeyFor,
  senderKeyFor,
  mergeHistogram,
} from "./sender-priors";
export type {
  SenderPrior,
  IncrementSenderPriorArgs,
  SenderPriorWriteKeyArgs,
} from "./sender-priors";
export { assembleObservations, extractGmailSignals, extractContentFlags } from "./observations";
export type {
  Observations,
  GmailSignals,
  ContentFlags,
  AssembleObservationsArgs,
} from "./observations";
