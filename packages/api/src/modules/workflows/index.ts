// Transitional barrel: re-exports domain logic from @alfred/assistant/automation.
// Routes stay here and import from this barrel.
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

export { workflowRoutes } from "./routes";
