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
 */

import { startRuntimeSpan, type RuntimeSpanCloser, type RuntimeSpanInput } from "@alfred/ai";
import type { DispatchResult } from "../dispatch";

/** Stable observation name for the dispatch-batch runtime span (PRD #405). */
export const RUNTIME_DISPATCH_BATCH = "runtime.dispatch.batch";

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

/** Coarse terminal status for the batch span. */
export type DispatchBatchStatus = "committed" | "staged" | "parked";

/**
 * Derive the batch's terminal status. A batch that parks — an HIL stage or a
 * still-running sub-agent await — is distinguished from one that ran every call
 * to completion, so the trace separates "run parked mid-batch" from "batch
 * committed". Staging takes precedence over a sub-agent park to mirror the
 * workflow's own precedence.
 */
export function dispatchBatchStatus(summary: DispatchBatchSummary): DispatchBatchStatus {
  if (summary.staged > 0) return "staged";
  if (summary.parked > 0) return "parked";
  return "committed";
}

export interface DispatchBatchSpanArgs {
  runId: string;
  /** Logical executor step that owns the batch (always `dispatch-tools`). */
  stepId: string;
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
      stepId: args.stepId,
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

// Injectable starter so a test can observe the emitted span contract without a
// live Langfuse client (mirrors dispatch's `_setDispatchTraceSinksForTests`).
let runtimeSpanStarter: (input: RuntimeSpanInput) => RuntimeSpanCloser = startRuntimeSpan;

/** Open the `runtime.dispatch.batch` span for a workflow's dispatch step. */
export function startDispatchBatchSpan(args: DispatchBatchSpanArgs): RuntimeSpanCloser {
  return runtimeSpanStarter(buildDispatchBatchSpanInput(args));
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
