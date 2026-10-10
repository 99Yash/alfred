import { closeAgentQueue } from "./queue";
import { registerRecipe } from "./registry";
import {
  cancelRun,
  getRun,
  lockStagingWithRunInTx,
  persistChatTurnRunInTx,
  redeliverRun,
  replayRun,
  signalRun,
  signalRunInTx,
  startRun,
  startRunInTx,
} from "./service";
import { closeSubAgentJoinWakeQueue } from "./sub-agent-join-wake-queue";
import {
  startSubAgentJoinWakeWorker,
  stopSubAgentJoinWakeWorker,
} from "./sub-agent-join-wake-worker";
import { verifyMeteringModels } from "./verify-models";
import { startAgentWorker, stopAgentWorker } from "./worker";

export {
  registerRecipe,
  startRun,
  startRunInTx,
  getRun,
  signalRun,
  signalRunInTx,
  lockStagingWithRunInTx,
  cancelRun,
  startAgentWorker,
  stopAgentWorker,
  startSubAgentJoinWakeWorker,
  stopSubAgentJoinWakeWorker,
  verifyMeteringModels,
};

export { isInternalWorkflowSlug, listPublicWorkflows, listResumeOnlyWorkflows } from "./registry";

export { normalizeDecisionTraceKey } from "./decision-traces";

// `automation`'s history reader reuses this projection, so a frozen and a live receipt read the
// same (#561).
export {
  EFFECT_RECEIPT_CAP,
  effectReceiptColumns,
  toEffectReceipt,
  type EffectReceiptSource,
} from "./run-outcome";

// `createRun` and `enqueueRun` stay private, so no outside caller can persist a run without
// delivering it.
export { persistChatTurnRunInTx, redeliverRun, replayRun };

export { closeAgentQueue, closeSubAgentJoinWakeQueue };

export type { RunStatus, WakeCondition } from "@alfred/contracts";

export type { Step, StepContext, StepResult, Workflow, WorkflowInput } from "./registry";

export type { CancelOutcome, SignalArgs, SignalOutcome } from "./service";

// Runtime helpers for the `chat` recipe. Execution never imports `chat`.
export {
  CHARS_PER_TOKEN,
  compactTranscript,
  compactWithRetry,
  estimateSerializedTokens,
  estimateTranscriptTokens,
} from "./run-compaction";

export { buildConnectedSummaryFromAvailability } from "./connected-summary";

export {
  formatRuntimeTimeGrounding,
  resolveRuntimeGroundingAnchor,
  RUNTIME_GROUNDING_PARK_GRACE_MS,
} from "./grounding";

export {
  foldToolSurfaceState,
  systemToolKernel,
  toolRuntimeForRun,
  toolSurfaceStateFields,
  uniqueToolNames,
} from "./tool-surface";

export { toolNamesFromState } from "./tool-surface-usage";

export { appendModelResponseMessages } from "./transcript-dedup";

export { appendSystemNote } from "./transcript-notes";

export { aggregateRunUsage } from "./usage-fold";

export { withStepLease, type StepLease } from "./executor";

export {
  shouldPublishToolStarted,
  toolCardStarted,
  toolCardTerminal,
} from "./workflows/tool-card-events";

export { toolEventOutcome } from "./workflows/tool-event-outcome";

export { pendingToolCallSchema } from "./workflows/pending-tool-call";

export {
  CAPACITY_RETRY_DELAYS_MS,
  CAPACITY_RETRY_JITTER_MS,
  CHAT_TURN_CAP_LANDING_NOTE,
  chatTurnCap,
  chatTurnCapVerdict,
  openChatTurnRetries,
  resetChatTurnRetryBudgets,
  type ChatTurnRetries,
} from "./workflows/turn-budgets";

export { PREVIEW_CHARS } from "./workflows/tool-preview";

export {
  registerWorkflowReadinessCheck,
  type WorkflowReadinessVerdict,
} from "./workflows/readiness-port";

export { joinChildRun, type JoinChildRunDeps, type ParkWake } from "./sub-agent-join";

export { scheduleSubAgentJoinWakeJob } from "./sub-agent-join-wake-queue";

// Approval workers (ADR-0034). Their scheduling stays in `tool-runtime`.
export {
  expireStaging,
  startApprovalExpiryWorker,
  stopApprovalExpiryWorker,
  type ExpireStagingResult,
  type StartApprovalExpiryWorkerOpts,
} from "./approval-expiry-worker";

export {
  startApprovalNotificationWorker,
  stopApprovalNotificationWorker,
  type StartApprovalNotificationWorkerOpts,
} from "./approval-notification-worker";

export {
  isTerminalChildStatus,
  listSpawnedChildRuns,
  readChildRunOutcome,
  type ChildRunOutcome,
} from "./sub-agents";

export type { AgentDbExecutor } from "./registry";
