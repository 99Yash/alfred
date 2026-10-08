import {
  boundedNameList,
  classifyLatency,
  startRuntimeSpan,
  type RuntimeSpanCloser,
  type RuntimeSpanInput,
} from "@alfred/ai";
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

/** Record a load the round made itself. Same span shape as `system.load_tool`, closed at once. */
export function recordRoundToolActivation(
  run: ToolCallRun,
  toolName: ToolName,
  source: RoundToolLoadSource,
): void {
  startToolLoadSpan({
    runId: run.runId,
    caller: run.caller === "boss" ? "boss" : `sub:${run.caller.subId}`,
    toolName,
    source,
    startedAt: new Date(),
  }).end({ outcome: "ok", latencyMs: 0 });
}

export const RUNTIME_TOOL_LOAD = "runtime.tool_load";

/** Mirrors `resolveExactToolLoad`. */
type ToolLoadOutcome = "ok" | "unknown_tool" | ToolUnavailabilityCode;

/**
 * `model_load`: `system.load_tool`. `inactive_bounce`: the model called an inactive
 * tool, so the round loaded it. `search_fold`: the round loaded the best search hit.
 */
type ToolLoadSource = "model_load" | RoundToolLoadSource;

export type RoundToolLoadSource = "inactive_bounce" | "search_fold";

export interface ToolLoadSpanArgs {
  runId: string;
  /** `boss` or `sub:<id>`. */
  caller: string;
  /** `loadToolInput` caps it at 120 chars. */
  toolName: string;
  source: ToolLoadSource;
  startedAt: Date;
}

/** Exported for tests. */
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
  end(result: { outcome: ToolLoadOutcome; latencyMs: number }): void;
  error(): void;
}

/**
 * The one owner of the `runtime.tool_load` span shape. A failed load is recoverable,
 * so it closes at WARNING, not ERROR. Only the first `end`/`error` closes.
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

export const RUNTIME_TOOL_SEARCH = "runtime.tool_search";

export interface ToolSearchSpanArgs {
  runId: string;
  /** `boss` or `sub:<id>`. */
  caller: string;
  /** Never the raw query text. */
  queryChars: number;
  startedAt: Date;
}

/** Exported for tests. */
export function buildToolSearchSpanInput(args: ToolSearchSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_TOOL_SEARCH,
    startedAt: args.startedAt,
    metadata: {
      source: "model_search",
      caller: args.caller,
      queryChars: args.queryChars,
    },
  };
}

export interface ToolSearchSpanCloser {
  /** Names are kept so tuning can tell "found the wrong tools" from "found nothing". */
  end(result: { candidateNames: readonly ToolName[]; latencyMs: number }): void;
  error(): void;
}

/** No candidates is a `miss`, not an error. Only the first `end`/`error` closes. */
export function startToolSearchSpan(args: ToolSearchSpanArgs): ToolSearchSpanCloser {
  const span = runtimeSpanStarter(buildToolSearchSpanInput(args));
  let ended = false;

  return {
    end({ candidateNames, latencyMs }) {
      if (ended) return;
      ended = true;
      span.end({
        status: candidateNames.length > 0 ? "hit" : "miss",
        metadata: {
          candidateCount: candidateNames.length,
          candidateTools: boundedNameList(candidateNames),
          latencyMs,
          latencyHealth: classifyLatency("tool_search", latencyMs),
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
  const counts = new Map<string, number>([
    ["executed", 0],
    ["staged", 0],
    ["parked", 0],
    ["rejected", 0],
    ["invalidInput", 0],
    ["unknownTool", 0],
    ["inactiveTool", 0],
    ["notAllowed", 0],
    ["featureDisabled", 0],
    ["failed", 0],
  ]);

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

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(counts);
}
