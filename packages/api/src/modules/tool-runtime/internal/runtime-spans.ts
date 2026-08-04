import { startRuntimeSpan, type RuntimeSpanCloser, type RuntimeSpanInput } from "@alfred/ai";
import type { ToolName, ToolUnavailabilityCode } from "@alfred/contracts";

import type { ToolCallRun } from "../index";
import type { ToolCallDispatchResult } from "./adapter";

const RUNTIME_DISPATCH_BATCH = "runtime.dispatch.batch";
let runtimeSpanStarter: (input: RuntimeSpanInput) => RuntimeSpanCloser = startRuntimeSpan;

export interface ToolCallBatchSpan {
  end(
    terminal: "committed" | "staged" | "parked",
    results: readonly (ToolCallDispatchResult | undefined)[],
  ): void;
  end(terminal: "error"): void;
}

export function startToolCallBatchSpan(run: ToolCallRun, callCount: number): ToolCallBatchSpan {
  const span = runtimeSpanStarter({
    runId: run.runId,
    name: RUNTIME_DISPATCH_BATCH,
    startedAt: new Date(),
    metadata: {
      stepId: run.stepId,
      workflow: run.workflow,
      caller: run.caller === "boss" ? "boss" : `sub:${run.caller.subId}`,
      callCount,
    },
  });
  let ended = false;
  const end = (
    terminal: "committed" | "staged" | "parked" | "error",
    results?: readonly (ToolCallDispatchResult | undefined)[],
  ): void => {
    if (ended) return;
    ended = true;
    span.end({
      status: terminal,
      level: terminal === "error" ? "ERROR" : undefined,
      metadata: results ? summarize(results) : undefined,
    });
  };
  return {
    end,
  };
}

/**
 * Record a lazy tool activation that the dispatcher forced through an
 * inactive-bounce. It closes the load span immediately: the tool is already
 * resolved by the time the dispatcher bounces the schema-blind call, so the load
 * itself has no measurable latency (`latencyMs: 0`, `loaded: true`). It shares
 * `startToolLoadSpan` with the explicit `system.load_tool` path so both load
 * sources emit an identically shaped span and one count covers every lazy
 * activation (#414).
 */
export function recordInactiveToolActivation(run: ToolCallRun, toolName: ToolName): void {
  startToolLoadSpan({
    runId: run.runId,
    caller: run.caller === "boss" ? "boss" : `sub:${run.caller.subId}`,
    toolName,
    source: "inactive_bounce",
    startedAt: new Date(),
  }).end({ outcome: "ok", latencyMs: 0 });
}

/** Stable observation name for the exact-tool-load runtime span (PRD #405). */
export const RUNTIME_TOOL_LOAD = "runtime.tool_load";

/** Outcome of an exact tool load — mirrors `resolveExactToolLoad`. */
type ToolLoadOutcome = "ok" | "unknown_tool" | ToolUnavailabilityCode;

/**
 * How a lazy tool reached the active surface. A `runtime.tool_load` span is
 * emitted for both, so a count of the span reflects every lazy activation — not
 * only the explicit half (#414). `model_load`: the model called
 * `system.load_tool`. `inactive_bounce`: the model called the tool directly, the
 * dispatcher bounced the schema-blind call, and the workflow auto-activated it
 * for the next turn.
 */
type ToolLoadSource = "model_load" | "inactive_bounce";

export interface ToolLoadSpanArgs {
  runId: string;
  /** `boss` or `sub:<id>`. */
  caller: string;
  /** Bounded exact-name candidate requested by the model (`loadToolInput` caps it at 120 chars). */
  toolName: string;
  /** Which path activated the tool; separable in dashboards without splitting the span name. */
  source: ToolLoadSource;
  startedAt: Date;
}

/** Pure builder for the `runtime.tool_load` opening span. Exported for tests. */
export function buildToolLoadSpanInput(args: ToolLoadSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_TOOL_LOAD,
    startedAt: args.startedAt,
    metadata: {
      source: args.source,
      caller: args.caller,
      toolName: args.toolName,
    },
  };
}

export interface ToolLoadSpanCloser {
  /** Close with the load outcome and measured latency. */
  end(result: { outcome: ToolLoadOutcome; latencyMs: number }): void;
  error(): void;
}

/**
 * Open a `runtime.tool_load` span around an exact tool load. A failed load is
 * recoverable (the model can search again), so a non-`ok` outcome closes at
 * WARNING rather than ERROR — visible for discovery tuning without reading as a
 * fault. Idempotent — only the first `end`/`error` closes.
 *
 * This is the single owner of the `runtime.tool_load` span shape. Both load
 * paths route through it: the explicit `system.load_tool` tool (`tools/system.ts`,
 * via the `tool-runtime` public re-export) and the dispatcher inactive-bounce
 * (`recordInactiveToolActivation` above). Neither may hand-copy the shape.
 */
export function startToolLoadSpan(args: ToolLoadSpanArgs): ToolLoadSpanCloser {
  const span = runtimeSpanStarter(buildToolLoadSpanInput(args));
  let ended = false;
  return {
    end({ outcome, latencyMs }) {
      if (ended) return;
      ended = true;
      span.end({
        status: outcome,
        level: outcome === "ok" ? "DEFAULT" : "WARNING",
        metadata: { latencyMs, loaded: outcome === "ok" },
      });
    },
    error() {
      if (ended) return;
      ended = true;
      span.end({ status: "error", level: "ERROR" });
    },
  };
}

export function _setToolRuntimeSpanStarterForTests(
  starter: (input: RuntimeSpanInput) => RuntimeSpanCloser,
): () => void {
  const previous = runtimeSpanStarter;
  runtimeSpanStarter = starter;
  return () => {
    runtimeSpanStarter = previous;
  };
}

function summarize(
  results: readonly (ToolCallDispatchResult | undefined)[],
): Record<string, number> {
  const counts: Record<string, number> = {
    executed: 0,
    staged: 0,
    parked: 0,
    rejected: 0,
    invalidInput: 0,
    unknownTool: 0,
    inactiveTool: 0,
    notAllowed: 0,
    featureDisabled: 0,
    failed: 0,
  };
  for (const result of results) {
    if (!result) continue;
    const key =
      result.kind === "invalid_input"
        ? "invalidInput"
        : result.kind === "unknown_tool"
          ? "unknownTool"
          : result.kind === "inactive_tool"
            ? "inactiveTool"
            : result.kind === "not_allowed"
              ? "notAllowed"
              : result.kind === "feature_disabled"
                ? "featureDisabled"
                : result.kind;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
