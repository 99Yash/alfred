/**
 * Runtime observation spans for agent orchestration (#406, PRD #405).
 *
 * The Langfuse trace tree already covers the execution spine: LLM generations,
 * tool executions, and dispatch rejections. What it does *not* separate is the
 * deterministic orchestration overhead *around* those. This module separates
 * dispatch batches, first-turn tool preloading, approval/sub-agent waits, and
 * queue leases so operators can attribute time outside the model and tools.
 *
 * Tool-runtime owns dispatch-batch spans. This module owns the remaining agent
 * orchestration observations and keeps their runtime-span starter injectable
 * for focused tests.
 *
 * #409 (PRD #405) extends this module with three *wait/queue* spans that cover
 * the wall-clock a run spends *outside* the model and tools — waiting on a
 * human approval (`runtime.approval.wait`), waiting on a sub-agent child
 * (`runtime.sub_agent.wait`), and sitting in the queue between steps, including
 * stale-lease reclaim (`runtime.queue.lease`). They live here alongside the
 * batch span because all four are agent-orchestration runtime observations, and
 * they share the same injectable `runtimeSpanStarter` seam.
 */

import {
  boundedNameList,
  classifyLatency,
  startRuntimeSpan,
  type RuntimeSpanCloser,
  type RuntimeSpanInput,
} from "@alfred/ai";
import type { ToolName } from "@alfred/contracts";

/** Stable observation name for deterministic first-turn tool selection. */
export const RUNTIME_TOOL_PRELOAD = "runtime.tool.preload";

export interface ToolPreloadSpanArgs {
  runId: string;
  workflow: string;
  caller: string;
  activeBefore: number;
  allowedIntegrationCount: number;
  startedAt: Date;
}

/**
 * Pure builder for preload telemetry. Raw prompt text is deliberately excluded:
 * tool names and bounded counts are enough to review selection without putting
 * user-authored content into always-on Langfuse metadata.
 */
export function buildToolPreloadSpanInput(args: ToolPreloadSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_TOOL_PRELOAD,
    startedAt: args.startedAt,
    metadata: {
      source: "deterministic_preload",
      workflow: args.workflow,
      caller: args.caller,
      activeBefore: args.activeBefore,
      allowedIntegrationCount: args.allowedIntegrationCount,
    },
  };
}

export interface ToolPreloadSpanCloser {
  end(selectedTools: readonly ToolName[], activeAfter: number, promptChars: number): void;
  error(): void;
}

/** Open a span around availability filtering, ranking, and activation. */
export function startToolPreloadSpan(args: ToolPreloadSpanArgs): ToolPreloadSpanCloser {
  const span = runtimeSpanStarter(buildToolPreloadSpanInput(args));
  let ended = false;
  return {
    end(selectedTools, activeAfter, promptChars) {
      if (ended) return;
      ended = true;
      span.end({
        status: selectedTools.length > 0 ? "selected" : "no_match",
        metadata: {
          selectedCount: selectedTools.length,
          selectedTools: boundedNameList(selectedTools),
          activeAfter,
          promptChars,
        },
      });
    },
    error() {
      if (ended) return;
      ended = true;
      span.end({ status: "error", level: "ERROR" });
    },
  };
}

let runtimeSpanStarter: (input: RuntimeSpanInput) => RuntimeSpanCloser = startRuntimeSpan;

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
export type QueueLeaseFromStatus = "pending" | "runnable" | "running" | "deferred";

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

/* ---------------------------------------------------------------------------
 * Lazy-tool quality spans (#414, PRD #405)
 *
 * The preload span above measures deterministic first-turn selection. This one
 * measures what the model was shown on a given turn (`runtime.tool_surface` —
 * active/kernel/loaded counts + estimated schema payload). The other two
 * lazy-tool spans now live in `tool-runtime`: `runtime.tool_load` (both load
 * paths — explicit `system.load_tool` and dispatcher inactive-bounce — must emit
 * an identically shaped span) and `runtime.tool_search` (the model-facing
 * catalog search, whose only caller is `system.search_tools`); see
 * `tool-runtime/internal/runtime-spans.ts`. Together they let an operator judge
 * whether lazy loading is shrinking the payload rather than moving latency
 * around, and where discovery metadata is too weak for search to find the right
 * tool.
 * ------------------------------------------------------------------------- */

/** Stable observation name for the per-turn tool-surface runtime span (PRD #405). */
export const RUNTIME_TOOL_SURFACE = "runtime.tool_surface";

export interface ToolSurfaceSpanArgs {
  runId: string;
  /** Workflow slug — chat-turn vs user-authored-brief. */
  workflow: string;
  /** `boss` or `sub:<id>` — mirrors the dispatcher's caller label. */
  caller: string;
  startedAt: Date;
}

/** Pure builder for the tool-surface span's opening input. Exported for tests. */
export function buildToolSurfaceSpanInput(args: ToolSurfaceSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_TOOL_SURFACE,
    startedAt: args.startedAt,
    metadata: {
      workflow: args.workflow,
      caller: args.caller,
    },
  };
}

/** The surface the model was shown this turn, folded onto the span at end. */
interface ToolSurfaceSummary {
  /** Total tools the model can call this turn (after caller/thread gating). */
  activeCount: number;
  /** Of those, the always-on kernel tools. */
  kernelCount: number;
  /** Of those, lazily loaded (preloaded or searched-and-loaded) tools. */
  loadedCount: number;
  /** The lazily loaded tool names — the surface's growth over the kernel. */
  loadedTools: readonly ToolName[];
  /** Estimated serialized JSON-schema payload (bytes) for the whole surface. */
  schemaBytes: number;
  /** The same payload as an approximate token count. */
  schemaTokens: number;
  /**
   * Wall time to *rebuild* the surface (ms) — the SDK tool set and per-tool
   * schema sizes are both memoized, so this is near-zero on a steady-state turn
   * and only spikes when a never-before-seen active-set forces a cold rebuild.
   * It measures rebuild cost / cache churn, not the surface's size (that is
   * `schemaBytes`/`schemaTokens`); judged against the `schema_rebuild` band.
   */
  schemaRebuildMs: number;
}

export interface ToolSurfaceSpanCloser {
  end(summary: ToolSurfaceSummary): void;
  error(): void;
}

/**
 * Open a `runtime.tool_surface` span for one model turn. Records the active
 * surface size, the kernel/loaded split, the loaded tool names, and the
 * estimated schema payload (the budget signal), plus a `schema_rebuild` health
 * band that flags a cold surface rebuild (near-zero on memoized turns).
 * Building the surface is expected work, so it closes at level DEFAULT.
 * Idempotent — only the first `end`/`error` closes.
 */
export function startToolSurfaceSpan(args: ToolSurfaceSpanArgs): ToolSurfaceSpanCloser {
  const span = runtimeSpanStarter(buildToolSurfaceSpanInput(args));
  let ended = false;
  return {
    end(summary) {
      if (ended) return;
      ended = true;
      span.end({
        status: "measured",
        metadata: {
          activeCount: summary.activeCount,
          kernelCount: summary.kernelCount,
          loadedCount: summary.loadedCount,
          loadedTools: boundedNameList(summary.loadedTools),
          schemaBytes: summary.schemaBytes,
          schemaTokens: summary.schemaTokens,
          schemaRebuildMs: summary.schemaRebuildMs,
          schemaRebuildHealth: classifyLatency("schema_rebuild", summary.schemaRebuildMs),
        },
      });
    },
    error() {
      if (ended) return;
      ended = true;
      span.end({ status: "error", level: "ERROR" });
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
