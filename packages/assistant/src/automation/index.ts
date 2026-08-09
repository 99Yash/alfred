// Public seam for the automation module (renamed from workflows).
// Owns user-authored workflow definitions, revisions, readiness, triggers,
// schedules, occurrence claims. HTTP routes stay in @alfred/api and import from here.

export {
  DEFAULT_WORKFLOW_TIMEZONE,
  computeNextRunAt,
  resolveWorkflowTimezone,
  validateCronTrigger,
} from "./scheduling";

export { canonicalWorkflowDefinition, workflowRevisionContentHash } from "./content-hash";

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
} from "./revisions";

export type {
  ActivateWorkflowArgs,
  CreateWorkflowDraftArgs,
  InactiveWorkflowStatus,
  ReviseWorkflowArgs,
  WorkflowDefinitionDraft,
  WorkflowDefinitionPatch,
  WorkflowRevisedOutcome,
  WorkflowRevisionOutcome,
  WorkflowRevisionProblem,
  WorkflowRevisionProblemCode,
  WorkflowServiceFailure,
  WorkflowServiceResult,
} from "./revisions";

export {
  prepareWorkflowApprovalEdit,
  restageWorkflowApproval,
  type WorkflowApprovalEditPreparation,
} from "./approval-activation";

export { acceptEvent } from "./events";

export { seedBuiltinWorkflowsForAllUsers, seedBuiltinWorkflowsForUser } from "./seeder";

export { dispatchDueCronWorkflows } from "./tick";
export type { TickResult } from "./tick";

export {
  getWorkflowsQueue,
  startWorkflowsWorker,
  stopWorkflowsWorker,
  closeWorkflowsQueue,
  scheduleRepeatableWorkflowsJobs,
} from "./queue";
export type { WorkflowsJobData, StartWorkflowsWorkerOpts } from "./queue";

export { registerWorkflowSystemToolAdapter } from "./system-tool-adapter";
export { workflowRecoveryNavigation } from "./recovery-navigation";

export { checkWorkflowRunReadiness, type RuntimeReadinessResult } from "./runtime-readiness";
