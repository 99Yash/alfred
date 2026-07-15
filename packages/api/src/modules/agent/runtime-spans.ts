/**
 * Runtime observation spans for agent orchestration (#406, PRD #405).
 *
 * The Langfuse trace tree already covers the execution spine: LLM generations,
 * tool executions, and dispatch rejections. What it does *not* separate is the
 * deterministic orchestration overhead *around* those — the priority blind
 * spot this slice closes is the **dispatch batch**: the workflow step that fans
 * a round of tool calls out to `dispatchToolCall` (concurrently for reads,
 * serially for gated writes). Without a span there, batch overhead is folded
 * invisibly into the gap between the boss generation and the individual tool
 * spans, so an operator can't tell orchestration time from model/tool time.
 *
 * This module owns the batch-span contract (name, metadata, per-outcome
 * summary) as pure, testable helpers, plus a thin `startDispatchBatchSpan`
 * wrapper over `@alfred/ai`'s `startRuntimeSpan`. The starter is injectable
 * (`_setRuntimeSpanStarterForTests`) so a test can assert the emitted contract
 * without a live Langfuse client — mirroring the dispatcher's
 * `_setDispatchTraceSinksForTests` seam.
 *
 * #409 (PRD #405) extends this module with three *wait/queue* spans that cover
 * the wall-clock a run spends *outside* the model and tools — waiting on a
 * human approval (`runtime.approval.wait`), waiting on a sub-agent child
 * (`runtime.sub_agent.wait`), and sitting in the queue between steps, including
 * stale-lease reclaim (`runtime.queue.lease`). They live here alongside the
 * batch span because all four are agent-orchestration runtime observations, and
 * they share the same injectable `runtimeSpanStarter` seam.
 */

import { startRuntimeSpan, type RuntimeSpanCloser, type RuntimeSpanInput } from "@alfred/ai";
import type { DispatchResult } from "../dispatch";

/** Stable observation name for the dispatch-batch runtime span (PRD #405). */
export const RUNTIME_DISPATCH_BATCH = "runtime.dispatch.batch";

/**
 * The executor step that owns a dispatch batch. Only the `dispatch-tools` step
 * of either workflow opens this span, so the step id is a constant of the
 * contract rather than a caller-supplied value.
 */
const DISPATCH_BATCH_STEP_ID = "dispatch-tools";

/** Per-outcome tally of one dispatched tool-call batch. */
export interface DispatchBatchSummary {
  /** Total calls in the batch, including undispatched (`undefined`) slots. */
  callCount: number;
  executed: number;
  staged: number;
  parked: number;
  rejected: number;
  invalidInput: number;
  unknownTool: number;
  inactiveTool: number;
  notAllowed: number;
  failed: number;
}

/**
 * Fold a batch's dispatch results into per-outcome counts. Accepts sparse
 * arrays (`undefined` slots are calls the workflow left undispatched on this
 * pass — e.g. gated siblings after the first stage); those count toward
 * `callCount` but no outcome bucket.
 */
export function summarizeDispatchBatch(
  results: readonly (DispatchResult | undefined)[],
): DispatchBatchSummary {
  const summary: DispatchBatchSummary = {
    callCount: results.length,
    executed: 0,
    staged: 0,
    parked: 0,
    rejected: 0,
    invalidInput: 0,
    unknownTool: 0,
    inactiveTool: 0,
    notAllowed: 0,
    failed: 0,
  };
  for (const result of results) {
    switch (result?.kind) {
      case "executed":
        summary.executed += 1;
        break;
      case "staged":
        summary.staged += 1;
        break;
      case "parked":
        summary.parked += 1;
        break;
      case "rejected":
        summary.rejected += 1;
        break;
      case "invalid_input":
        summary.invalidInput += 1;
        break;
      case "unknown_tool":
        summary.unknownTool += 1;
        break;
      case "inactive_tool":
        summary.inactiveTool += 1;
        break;
      case "not_allowed":
        summary.notAllowed += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      default:
        // undefined slot — undispatched on this pass; counted in callCount only.
        break;
    }
  }
  return summary;
}

/**
 * Terminal outcome of a dispatched batch — the exact vocabulary the workflows
 * emit at each `return`. A batch either committed every call, `staged` a gated
 * write (HIL park), `parked` on a still-running sub-agent await, or faulted
 * (`error`). This is the single source for that vocabulary; the closer's typed
 * `end` makes a typo or a new-but-unhandled terminal a compile error.
 */
export type DispatchBatchTerminal = "committed" | "staged" | "parked" | "error";

export interface DispatchBatchSpanArgs {
  runId: string;
  /** Workflow slug — chat-turn vs user-authored-brief. */
  workflow: string;
  /** `boss` or `sub:<id>` — mirrors the dispatcher's caller label. */
  caller: string;
  callCount: number;
  startedAt: Date;
}

/** Pure builder for the batch span's opening input. Exported for tests. */
export function buildDispatchBatchSpanInput(args: DispatchBatchSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_DISPATCH_BATCH,
    startedAt: args.startedAt,
    metadata: {
      stepId: DISPATCH_BATCH_STEP_ID,
      workflow: args.workflow,
      caller: args.caller,
      callCount: args.callCount,
    },
  };
}

/** Per-outcome counts folded onto the batch span at end. Exported for tests. */
export function dispatchBatchEndMetadata(summary: DispatchBatchSummary): Record<string, number> {
  return {
    executed: summary.executed,
    staged: summary.staged,
    parked: summary.parked,
    rejected: summary.rejected,
    invalidInput: summary.invalidInput,
    unknownTool: summary.unknownTool,
    inactiveTool: summary.inactiveTool,
    notAllowed: summary.notAllowed,
    failed: summary.failed,
  };
}

/**
 * Closer for a `runtime.dispatch.batch` span. Owns the one rule for how a batch
 * span ends so it can't drift between the two workflows: a `committed`/`staged`/
 * `parked` terminal folds the batch's per-outcome summary into end metadata; an
 * `error` terminal records level `ERROR` with no summary (the batch faulted
 * before a meaningful tally). Idempotent — only the first `end` closes the span.
 */
export interface DispatchBatchSpanCloser {
  end(
    terminal: "committed" | "staged" | "parked",
    results: readonly (DispatchResult | undefined)[],
  ): void;
  end(terminal: "error"): void;
}

// Injectable starter so a test can observe the emitted span contract without a
// live Langfuse client (mirrors dispatch's `_setDispatchTraceSinksForTests`).
let runtimeSpanStarter: (input: RuntimeSpanInput) => RuntimeSpanCloser = startRuntimeSpan;

/** Open the `runtime.dispatch.batch` span for a workflow's dispatch step. */
export function startDispatchBatchSpan(args: DispatchBatchSpanArgs): DispatchBatchSpanCloser {
  const span = runtimeSpanStarter(buildDispatchBatchSpanInput(args));
  let ended = false;
  return {
    end(
      terminal: DispatchBatchTerminal,
      results?: readonly (DispatchResult | undefined)[],
    ): void {
      if (ended) return;
      ended = true;
      span.end({
        status: terminal,
        level: terminal === "error" ? "ERROR" : undefined,
        metadata: results ? dispatchBatchEndMetadata(summarizeDispatchBatch(results)) : undefined,
      });
    },
  };
}

/* ---------------------------------------------------------------------------
 * Wait & queue spans (#409, PRD #405)
 *
 * The batch span above measures orchestration *inside* a step. These three
 * measure the wall-clock a run spends *between* / *outside* model and tool work
 * — the time an operator otherwise can't attribute. Each is emitted after the
 * fact as a point observation: opened backdated to the wait's start and closed
 * `now`, so Langfuse derives the true duration. All three swallow SDK faults
 * via the shared `runtimeSpanStarter`, so a tracing hiccup never breaks the
 * orchestration path they observe.
 * ------------------------------------------------------------------------- */

/** Non-negative elapsed ms between two instants (clamped against clock skew). */
function waitMsBetween(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

/** Stable observation name for the approval-wait runtime span (PRD #405). */
export const RUNTIME_APPROVAL_WAIT = "runtime.approval.wait";

/** How a gated action's approval wait ended. */
export type ApprovalWaitOutcome = "approved" | "rejected" | "expired" | "cancelled";

export interface ApprovalWaitSpanArgs {
  /** Run id whose gated action was parked — doubles as the trace id. */
  runId: string;
  /** `action_stagings.created_at` — the instant the approval was requested. */
  startedAt: Date;
  toolName: string;
  integration: string;
  riskTier: string;
}

/** Pure builder for the `runtime.approval.wait` opening span. Exported for tests. */
export function buildApprovalWaitSpanInput(args: ApprovalWaitSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_APPROVAL_WAIT,
    startedAt: args.startedAt,
    metadata: {
      toolName: args.toolName,
      integration: args.integration,
      riskTier: args.riskTier,
    },
  };
}

export interface ApprovalWaitSpanCloser {
  /** Close the wait with its outcome; `endedAt` is the decision/expiry instant. */
  end(outcome: ApprovalWaitOutcome, endedAt: Date): void;
}

/**
 * Open a `runtime.approval.wait` span. An approval wait is expected, not an
 * error, so it always closes at level DEFAULT; the `outcome` distinguishes an
 * approve from a reject/expire/cancel. Idempotent — only the first `end` closes.
 */
export function startApprovalWaitSpan(args: ApprovalWaitSpanArgs): ApprovalWaitSpanCloser {
  const span = runtimeSpanStarter(buildApprovalWaitSpanInput(args));
  let ended = false;
  return {
    end(outcome, endedAt) {
      if (ended) return;
      ended = true;
      span.end({
        status: outcome,
        metadata: { outcome, waitMs: waitMsBetween(args.startedAt, endedAt) },
      });
    },
  };
}

/** Stable observation name for the sub-agent-wait runtime span (PRD #405). */
export const RUNTIME_SUB_AGENT_WAIT = "runtime.sub_agent.wait";

/** Terminal status of the awaited sub-agent child. */
export type SubAgentWaitOutcome = "completed" | "failed" | "cancelled";

export interface SubAgentWaitSpanArgs {
  /** Parent run id — the trace this wait hangs under. */
  runId: string;
  /** Parent park instant: its interrupted step's `ended_at`. */
  startedAt: Date;
  childRunId: string;
  parentStepId: string;
}

/** Pure builder for the `runtime.sub_agent.wait` opening span. Exported for tests. */
export function buildSubAgentWaitSpanInput(args: SubAgentWaitSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_SUB_AGENT_WAIT,
    startedAt: args.startedAt,
    metadata: {
      childRunId: args.childRunId,
      parentStepId: args.parentStepId,
    },
  };
}

export interface SubAgentWaitSpanCloser {
  /** Close the wait with the child's terminal status; `endedAt` is the wake instant. */
  end(outcome: SubAgentWaitOutcome, endedAt: Date): void;
}

/**
 * Open a `runtime.sub_agent.wait` span. Like an approval wait, a join is
 * expected work, so it closes at level DEFAULT and the `outcome` carries the
 * child's terminal status. Idempotent — only the first `end` closes.
 */
export function startSubAgentWaitSpan(args: SubAgentWaitSpanArgs): SubAgentWaitSpanCloser {
  const span = runtimeSpanStarter(buildSubAgentWaitSpanInput(args));
  let ended = false;
  return {
    end(outcome, endedAt) {
      if (ended) return;
      ended = true;
      span.end({
        status: outcome,
        metadata: { outcome, waitMs: waitMsBetween(args.startedAt, endedAt) },
      });
    },
  };
}

/** Stable observation name for the queue/lease runtime span (PRD #405). */
export const RUNTIME_QUEUE_LEASE = "runtime.queue.lease";

/** Run status observed just before a lease flipped it to `running`. */
export type QueueLeaseFromStatus = "pending" | "runnable" | "running";

export interface QueueLeaseSpanArgs {
  runId: string;
  /** Workflow slug of the leased run. */
  workflow: string;
  /** Step this lease is about to run. */
  stepId: string;
  fromStatus: QueueLeaseFromStatus;
  /** True when a stale `running` row was reclaimed (previous worker presumed dead). */
  reclaimed: boolean;
  /**
   * `now - last_checkpoint_at` at lease time (ms); null when the row was never
   * checkpointed (a fresh `pending` run). The span backdates its start by this.
   */
  queueMs: number | null;
  /** The lease instant — the span's end time and the anchor for backdating. */
  leasedAt: Date;
}

/** Pure builder for the `runtime.queue.lease` opening span. Exported for tests. */
export function buildQueueLeaseSpanInput(args: QueueLeaseSpanArgs): RuntimeSpanInput {
  const startedAt =
    args.queueMs == null ? args.leasedAt : new Date(args.leasedAt.getTime() - args.queueMs);
  return {
    runId: args.runId,
    name: RUNTIME_QUEUE_LEASE,
    startedAt,
    metadata: {
      fromStatus: args.fromStatus,
      workflow: args.workflow,
      stepId: args.stepId,
    },
  };
}

export interface QueueLeaseSpanCloser {
  end(): void;
}

/**
 * Open (and, on `end`, close) a `runtime.queue.lease` span. A reclaim is a
 * stale-lease recovery — an unhealthy signal — so it closes at level WARNING; a
 * normal lease closes at DEFAULT. Idempotent — only the first `end` closes.
 */
export function startQueueLeaseSpan(args: QueueLeaseSpanArgs): QueueLeaseSpanCloser {
  const span = runtimeSpanStarter(buildQueueLeaseSpanInput(args));
  let ended = false;
  return {
    end() {
      if (ended) return;
      ended = true;
      span.end({
        status: args.reclaimed ? "reclaimed" : "leased",
        level: args.reclaimed ? "WARNING" : "DEFAULT",
        metadata: { reclaimed: args.reclaimed, queueMs: args.queueMs },
      });
    },
  };
}

export function _setRuntimeSpanStarterForTests(
  starter: (input: RuntimeSpanInput) => RuntimeSpanCloser,
): () => void {
  const previous = runtimeSpanStarter;
  runtimeSpanStarter = starter;
  return () => {
    runtimeSpanStarter = previous;
  };
}
