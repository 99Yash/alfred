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

/* ---------------------------------------------------------------------------
 * Model-facing tool-search span (#414, PRD #405)
 *
 * The load span above records what reaches the active surface. This one records
 * the model-facing catalog search that finds a tool to load. It lives beside the
 * load span so tool-load and tool-search — the two lazy-tool discovery spans —
 * share one owner and one `runtimeSpanStarter`. `tools/system.ts` is its only
 * caller (the `system.search_tools` tool), so no agent code imports it back.
 * ------------------------------------------------------------------------- */

/** Stable observation name for the model-facing tool-search runtime span (PRD #405). */
export const RUNTIME_TOOL_SEARCH = "runtime.tool_search";

export interface ToolSearchSpanArgs {
  runId: string;
  /** `boss` or `sub:<id>`. */
  caller: string;
  /** Length of the search query in chars — never the raw query text. */
  queryChars: number;
  startedAt: Date;
}

/** Pure builder for the `runtime.tool_search` opening span. Exported for tests. */
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
  /**
   * Close with the candidate tool names the search returned and measured
   * latency. An empty list is a `miss`. The names are recorded (bounded) so
   * discovery tuning can tell "found the wrong tools" from "found nothing" —
   * the more common metadata gap — instead of collapsing to a hit/miss binary.
   */
  end(result: { candidateNames: readonly ToolName[]; latencyMs: number }): void;
  error(): void;
}

/**
 * Open a `runtime.tool_search` span around a model-facing catalog search. A
 * search returning no candidates is a `miss` — the discovery-metadata gap the
 * PRD wants visible (User Story 17) — not an error, so it closes at DEFAULT with
 * `status:"miss"`. The returned candidate names (not PII) are recorded bounded
 * so an operator can see *what* was surfaced, not just how many. Latency is
 * judged against the `tool_search` debug band. Idempotent — only the first
 * `end`/`error` closes.
 */
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
