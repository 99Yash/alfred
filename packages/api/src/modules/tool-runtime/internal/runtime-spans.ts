import { startRuntimeSpan, type RuntimeSpanCloser, type RuntimeSpanInput } from "@alfred/ai";
import type { ToolName } from "@alfred/contracts";

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

export function recordInactiveToolActivation(run: ToolCallRun, toolName: ToolName): void {
  runtimeSpanStarter({
    runId: run.runId,
    name: "runtime.tool_load",
    startedAt: new Date(),
    metadata: {
      source: "inactive_bounce",
      caller: run.caller === "boss" ? "boss" : `sub:${run.caller.subId}`,
      toolName,
    },
  }).end({ status: "ok", level: "DEFAULT", metadata: { latencyMs: 0, loaded: true } });
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
