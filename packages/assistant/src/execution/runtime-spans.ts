/**
 * Langfuse spans for time a run spends outside the model and tools (PRD #405):
 * tool preload, approval and sub-agent waits, queue leases, and the per-turn tool surface.
 */

import {
  boundedNameList,
  classifyLatency,
  startRuntimeSpan,
  type RuntimeSpanCloser,
  type RuntimeSpanInput,
} from "@alfred/ai";
import type { ToolName } from "@alfred/contracts";

export const RUNTIME_TOOL_PRELOAD = "runtime.tool.preload";

export interface ToolPreloadSpanArgs {
  runId: string;
  workflow: string;
  caller: string;
  activeBefore: number;
  allowedIntegrationCount: number;
  startedAt: Date;
}

/** Leaves out the prompt text, so user content stays out of always-on Langfuse metadata. */
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

// Wait and queue spans (#409) are emitted after the fact: opened backdated to the
// wait's start and closed now. The starter swallows SDK faults.

/** Clamped at 0 against clock skew. */
function waitMsBetween(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

export const RUNTIME_APPROVAL_WAIT = "runtime.approval.wait";

/** `answered` and `dismissed` are question-card outcomes (ADR-0099). */
export type ApprovalWaitOutcome =
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "answered"
  | "dismissed";

export interface ApprovalWaitSpanArgs {
  /** Also the trace id. */
  runId: string;
  /** `action_stagings.created_at`. */
  startedAt: Date;
  toolName: string;
  integration: string;
  riskTier: string;
}

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
  end(outcome: ApprovalWaitOutcome, endedAt: Date): void;
}

/** A wait is not an error, so it always closes at DEFAULT. Only the first `end` counts. */
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

export const RUNTIME_SUB_AGENT_WAIT = "runtime.sub_agent.wait";

export type SubAgentWaitOutcome = "completed" | "failed" | "cancelled";

export interface SubAgentWaitSpanArgs {
  /** The parent run. */
  runId: string;
  /** The parent's interrupted step `ended_at`. */
  startedAt: Date;
  childRunId: string;
  parentStepId: string;
}

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
  end(outcome: SubAgentWaitOutcome, endedAt: Date): void;
}

/** Always closes at DEFAULT. Only the first `end` counts. */
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

export const RUNTIME_QUEUE_LEASE = "runtime.queue.lease";

/** The status just before the lease set `running`. */
export type QueueLeaseFromStatus = "pending" | "runnable" | "running" | "deferred";

export interface QueueLeaseSpanArgs {
  runId: string;
  workflow: string;
  stepId: string;
  fromStatus: QueueLeaseFromStatus;
  reclaimed: boolean;
  /** The span starts this far before `leasedAt`. Null for a never-checkpointed run. */
  queueMs: number | null;
  leasedAt: Date;
}

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

/** A reclaim closes at WARNING because a worker died; a normal lease at DEFAULT. */
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

// The tool-surface span (#414) records what the model was shown each turn.
// The load and search spans live in `tool-runtime/internal/runtime-spans.ts`.

export const RUNTIME_TOOL_SURFACE = "runtime.tool_surface";

export interface ToolSurfaceSpanArgs {
  runId: string;
  workflow: string;
  /** `boss` or `sub:<id>`, like the dispatcher's caller label. */
  caller: string;
  startedAt: Date;
}

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

interface ToolSurfaceSummary {
  activeCount: number;
  kernelCount: number;
  loadedCount: number;
  loadedTools: readonly ToolName[];
  schemaBytes: number;
  schemaTokens: number;
  /** Near zero when memoized; a spike means a new active set forced a cold rebuild. */
  schemaRebuildMs: number;
}

export interface ToolSurfaceSpanCloser {
  end(summary: ToolSurfaceSummary): void;
  error(): void;
}

/** Only the first `end` or `error` counts. */
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
