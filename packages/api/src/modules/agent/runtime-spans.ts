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

export function _setRuntimeSpanStarterForTests(
  starter: (input: RuntimeSpanInput) => RuntimeSpanCloser,
): () => void {
  const previous = runtimeSpanStarter;
  runtimeSpanStarter = starter;
  return () => {
    runtimeSpanStarter = previous;
  };
}
