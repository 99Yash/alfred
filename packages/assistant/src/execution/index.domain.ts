import { closeAgentQueue } from "./queue";
import { registerRecipe } from "./registry";
import {
  cancelRun,
  getRun,
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
  cancelRun,
  startAgentWorker,
  stopAgentWorker,
  startSubAgentJoinWakeWorker,
  stopSubAgentJoinWakeWorker,
  verifyMeteringModels,
};
// Recipe-registry queries and the decision-trace key normalizer are execution's
// to own; cross-module callers (workflow seeder, Replicache entity projection,
// triage's atomic trace write) reach them through this index, not through
// `agent/registry` or `agent/decision-traces` directly. `normalizeDecisionTraceKey`
// is exposed as a read-only key helper, not a trace write — the transaction owner
// (executor or triage) still writes its own row (ADR-0040).
export { isInternalWorkflowSlug, listPublicWorkflows, listResumeOnlyWorkflows } from "./registry";
export { normalizeDecisionTraceKey } from "./decision-traces";
// Execution's public run-start surface is `startRun` / `startRunInTx` (folded
// persist+deliver) plus two narrow ops for the callers that legitimately hold a
// run apart from its delivery: `redeliverRun(runId)` hands an already-persisted
// run to the worker (approvals re-delivery, the chat-turn post-commit kick, ops
// re-kicks, and the HTTP replay/signal endpoints), and `persistChatTurnRunInTx(tx,
// args)` persists a chat-turn run on the caller's transaction inside a savepoint.
// `replayRun(args)` re-persists a run from a revision choice and returns the new
// run for the caller to `redeliverRun`; it is the entry the `/runs/:runId/replay`
// HTTP transport calls (that transport moved to `@alfred/http` when execution left
// `agent/`, so the run-start surface it reaches must be public). The raw
// `createRun` / `enqueueRun` pair (and its former `deliverRun` alias) is still not
// re-exported here, so no caller outside execution can split persistence from
// delivery or reach the queue handle; both stay module-private.
export { persistChatTurnRunInTx, redeliverRun, replayRun };
export { closeAgentQueue, closeSubAgentJoinWakeQueue };
export type {
  RunStatus,
  Step,
  StepContext,
  StepResult,
  WakeCondition,
  Workflow,
  WorkflowInput,
} from "./types";
export type { CancelOutcome, SignalArgs, SignalOutcome } from "./service";

// Agent-runtime primitives the `conversations` chat recipe reaches through this
// public seam. The recipe lives in `conversations`; execution never imports it,
// so it consumes these turn/sub-agent/context helpers here rather than through
// private module paths.
//
// `run-compaction` exposes the generic `<run_summary>` token/window math the
// chat compaction files in `conversations/compaction` still share (ADR-0035);
// `grounding`, `instructions`, `connected-summary`, and `transcript-dedup` are
// permanent shared agent-runtime services — the sub-agent executor
// (`workflows/user-authored-brief.ts`) consumes them too, so they stay in
// `agent`. Chat context assembly, chat summaries, and chat compaction now live
// in `conversations/compaction` and are no longer reachable here.
export {
  CHARS_PER_TOKEN,
  compactTranscript,
  compactWithRetry,
  estimateSerializedTokens,
  estimateTranscriptTokens,
} from "./run-compaction";
export { buildConnectedSummaryFromAvailability } from "./connected-summary";
export { formatRuntimeTimeGrounding, resolveRuntimeGroundingAnchor } from "./grounding";
export {
  foldToolSurfaceState,
  systemToolKernel,
  toolRuntimeForRun,
  toolSurfaceStateFields,
} from "./tool-surface";
export { appendModelResponseMessages } from "./transcript-dedup";
export { aggregateRunUsage } from "./usage-fold";
export {
  shouldPublishToolStarted,
  toolCardStarted,
  toolCardTerminal,
} from "./workflows/tool-card-events";
export { toolEventOutcome } from "./workflows/tool-event-outcome";
export { pendingToolCallSchema } from "./workflows/pending-tool-call";
export {
  CHAT_TURN_CAP_MAX,
  openChatTurnRetries,
  resetChatTurnRetryBudgets,
} from "./workflows/turn-budgets";
export { PREVIEW_CHARS } from "./workflows/tool-preview";
export {
  registerWorkflowReadinessCheck,
  type WorkflowReadinessVerdict,
} from "./workflows/readiness-port";
export { joinChildRun, type JoinChildRunDeps, type ParkSignal } from "./sub-agent-join";
export { scheduleSubAgentJoinWakeJob } from "./sub-agent-join-wake-queue";
// Action-staging approval WORKERS (ADR-0034). Both wake/notify sides live in
// execution: the expiry worker drives the run-wake primitive (`signalRunInTx` /
// `redeliverRun`) and the notification worker sends through `../delivery`. The
// scheduling surface stays in `tool-runtime` (a sink).
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
export type { AgentDbExecutor } from "./types";
