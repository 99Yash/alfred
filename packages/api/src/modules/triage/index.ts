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

export { getTriage, upsertTriage, setAppliedLabelId, loadTriageContext } from "./store";
export type { TriageRow, UpsertTriageArgs, TriageDocumentContext } from "./store";

export { TRIAGE_WORKFLOW_SLUG, triageWorkflowInputSchema } from "./workflow-input";
export type { TriageWorkflowInput } from "./workflow-input";
