// Transitional barrel: re-exports domain logic from @alfred/assistant/automation.
// Transport left: the workflow route now lives in @alfred/http and imports
// @alfred/assistant/automation directly. What is left is the automation half of
// the @alfred/api/backend and @alfred/api/runtime service surface, plus the
// composition wiring, for server-side callers that have not moved to
// @alfred/assistant/automation yet. Do not enumerate those callers here — some
// of them live only in test files, which api's tsconfig.test.json excludes, so
// an enumeration written in this comment is invisible to every static gate and
// goes stale without anything saying so.
// @alfred/api/backend surface is unchanged (byte-identical re-exports).
// The module is renamed from workflows to automation in @alfred/assistant.

export {
  DEFAULT_WORKFLOW_TIMEZONE,
  computeNextRunAt,
  resolveWorkflowTimezone,
  validateCronTrigger,
} from "@alfred/assistant/automation";

export {
  canonicalWorkflowDefinition,
  workflowRevisionContentHash,
} from "@alfred/assistant/automation";

export {
  activateWorkflow,
  clearWorkflowBlocked,
  createWorkflowDraft,
  recoverWorkflowDraft,
  reviseWorkflow,
  reviseWorkflowFromPatch,
  setWorkflowBlocked,
  setWorkflowStatus,
  validateWorkflowDefinition,
  type ActivateWorkflowArgs,
  type CreateWorkflowDraftArgs,
  type InactiveWorkflowStatus,
  type ReviseWorkflowArgs,
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionPatch,
  type WorkflowRevisedOutcome,
  type WorkflowRevisionOutcome,
  type WorkflowRevisionProblem,
  type WorkflowRevisionProblemCode,
  type WorkflowServiceFailure,
  type WorkflowServiceResult,
} from "@alfred/assistant/automation";

export {
  prepareWorkflowApprovalEdit,
  restageWorkflowApproval,
  type WorkflowApprovalEditPreparation,
} from "@alfred/assistant/automation";

export { acceptEvent } from "@alfred/assistant/automation";

export {
  seedBuiltinWorkflowsForAllUsers,
  seedBuiltinWorkflowsForUser,
} from "@alfred/assistant/automation";

export { dispatchDueCronWorkflows, type TickResult } from "@alfred/assistant/automation";

export {
  getWorkflowsQueue,
  startWorkflowsWorker,
  stopWorkflowsWorker,
  closeWorkflowsQueue,
  scheduleRepeatableWorkflowsJobs,
  type WorkflowsJobData,
  type StartWorkflowsWorkerOpts,
} from "@alfred/assistant/automation";
