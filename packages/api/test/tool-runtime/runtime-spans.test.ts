import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import type { ToolCallRun } from "@alfred/assistant/tool-runtime";
import type { ToolCallDispatchResult } from "@alfred/assistant/tool-runtime/internal/adapter";
import {
  RUNTIME_TOOL_LOAD,
  RUNTIME_TOOL_SEARCH,
  _setToolRuntimeSpanStarterForTests,
  buildToolLoadSpanInput,
  buildToolSearchSpanInput,
  recordInactiveToolActivation,
  startToolCallBatchSpan,
  startToolLoadSpan,
  startToolSearchSpan,
} from "@alfred/assistant/tool-runtime/internal/runtime-spans";

// The batch summary only reads `.kind`, so a minimal typed literal is enough to
// exercise the count buckets without a live registry/dispatch.
const result = (kind: ToolCallDispatchResult["kind"]): ToolCallDispatchResult =>
  ({ kind }) as ToolCallDispatchResult;

function capture(run: () => void): { opened: RuntimeSpanInput[]; ended: RuntimeSpanEndArgs[] } {
  const opened: RuntimeSpanInput[] = [];
  const ended: RuntimeSpanEndArgs[] = [];
  const restore = _setToolRuntimeSpanStarterForTests((input) => {
    opened.push(input);
    return { end: (args) => ended.push(args) };
  });
  try {
    run();
  } finally {
    restore();
  }
  return { opened, ended };
}

const bossRun: ToolCallRun = {
  runId: "run_batch",
  stepId: "dispatch-tools",
  userId: "user_test",
  workflow: "__chat-turn__",
  caller: "boss",
  runContext: { caller: "boss", interaction: "background" },
};

const subRun: ToolCallRun = {
  ...bossRun,
  runId: "run_sub_batch",
  workflow: "__user-authored-brief__",
  caller: { subId: "research-1" },
  runContext: { caller: "sub_agent", interaction: "background" },
};

describe("startToolCallBatchSpan", () => {
  test("opens with run id, run step id, workflow, boss caller, and call count under the stable name", () => {
    const { opened } = capture(() => startToolCallBatchSpan(bossRun, 4).end("committed", []));
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.name, "runtime.dispatch.batch");
    assert.equal(opened[0]?.runId, "run_batch");
    assert.deepEqual(opened[0]?.metadata, {
      stepId: "dispatch-tools",
      workflow: "__chat-turn__",
      caller: "boss",
      callCount: 4,
    });
  });

  test("a sub-agent run labels the caller `sub:<id>`", () => {
    const { opened } = capture(() => startToolCallBatchSpan(subRun, 1).end("committed", []));
    assert.equal(opened[0]?.metadata?.caller, "sub:research-1");
  });

  test("a committed terminal folds every outcome into a flat count map at DEFAULT level", () => {
    const results = [
      result("executed"),
      result("executed"),
      result("failed"),
      result("inactive_tool"),
      result("rejected"),
      undefined, // an undispatched gated sibling — contributes to no bucket
    ];
    const { ended } = capture(() =>
      startToolCallBatchSpan(bossRun, results.length).end("committed", results),
    );
    assert.deepEqual(ended, [
      {
        status: "committed",
        level: undefined,
        metadata: {
          executed: 2,
          staged: 0,
          parked: 0,
          rejected: 1,
          invalidInput: 0,
          unknownTool: 0,
          inactiveTool: 1,
          notAllowed: 0,
          featureDisabled: 0,
          failed: 1,
        },
      },
    ]);
  });

  test("the non-execution kinds map to their own count keys", () => {
    const results = [
      result("invalid_input"),
      result("unknown_tool"),
      result("not_allowed"),
      result("feature_disabled"),
    ];
    const { ended } = capture(() =>
      startToolCallBatchSpan(bossRun, results.length).end("committed", results),
    );
    assert.equal(ended[0]?.metadata?.invalidInput, 1);
    assert.equal(ended[0]?.metadata?.unknownTool, 1);
    assert.equal(ended[0]?.metadata?.notAllowed, 1);
    assert.equal(ended[0]?.metadata?.featureDisabled, 1);
  });

  test("staged and parked terminals carry their own status with a folded summary", () => {
    const staged = capture(() =>
      startToolCallBatchSpan(bossRun, 1).end("staged", [result("staged")]),
    );
    assert.equal(staged.ended[0]?.status, "staged");
    assert.equal(staged.ended[0]?.metadata?.staged, 1);

    const parked = capture(() =>
      startToolCallBatchSpan(bossRun, 1).end("parked", [result("parked")]),
    );
    assert.equal(parked.ended[0]?.status, "parked");
    assert.equal(parked.ended[0]?.metadata?.parked, 1);
  });

  test("an error terminal records level ERROR and no summary", () => {
    const { ended } = capture(() => startToolCallBatchSpan(bossRun, 1).end("error"));
    assert.deepEqual(ended, [{ status: "error", level: "ERROR", metadata: undefined }]);
  });

  test("only the first end closes the span (a later catch must not double-end)", () => {
    const { ended } = capture(() => {
      const span = startToolCallBatchSpan(bossRun, 1);
      span.end("committed", [result("executed")]);
      span.end("error");
    });
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.status, "committed");
  });
});

describe("runtime.tool_load (single owner for both load paths)", () => {
  const args = {
    runId: "run_load",
    caller: "sub:sub_a",
    toolName: "calendar.list_events" as const,
    source: "model_load" as const,
    startedAt: new Date("2026-07-16T00:00:00.000Z"),
  };

  test("opens with the exact requested tool and model-load source", () => {
    const input = buildToolLoadSpanInput(args);
    assert.equal(input.name, RUNTIME_TOOL_LOAD);
    assert.equal(input.name, "runtime.tool_load");
    assert.deepEqual(input.metadata, {
      source: "model_load",
      caller: "sub:sub_a",
      toolName: "calendar.list_events",
    });
  });

  test("a successful load closes at DEFAULT with loaded=true", () => {
    const { ended } = capture(() => startToolLoadSpan(args).end({ outcome: "ok", latencyMs: 2 }));
    assert.deepEqual(ended, [
      { status: "ok", level: "DEFAULT", metadata: { latencyMs: 2, loaded: true } },
    ]);
  });

  test("a failed load is recoverable — WARNING, not ERROR — and distinguishes the reason", () => {
    for (const outcome of ["unknown_tool", "not_allowed", "not_connected"] as const) {
      const { ended } = capture(() => startToolLoadSpan(args).end({ outcome, latencyMs: 1 }));
      assert.deepEqual(ended, [
        { status: outcome, level: "WARNING", metadata: { latencyMs: 1, loaded: false } },
      ]);
    }
  });

  test("a dispatcher inactive-bounce activation emits the same span through the shared owner (#414)", () => {
    // Both the explicit `system.load_tool` path and this inactive-bounce path
    // must emit an identically shaped `runtime.tool_load` span so one count
    // covers every lazy activation. The inactive bounce differs only in
    // `source` and its zero-latency, already-resolved close.
    const { opened, ended } = capture(() =>
      recordInactiveToolActivation(bossRun, "calendar.list_events" as never),
    );
    assert.equal(opened[0]?.name, "runtime.tool_load");
    assert.deepEqual(opened[0]?.metadata, {
      source: "inactive_bounce",
      caller: "boss",
      toolName: "calendar.list_events",
    });
    assert.deepEqual(ended, [
      { status: "ok", level: "DEFAULT", metadata: { latencyMs: 0, loaded: true } },
    ]);
  });
});

describe("runtime.tool_search", () => {
  const args = {
    runId: "run_search",
    caller: "boss",
    queryChars: 17,
    startedAt: new Date("2026-07-16T00:00:00.000Z"),
  };

  test("opens with query length, never the raw query", () => {
    const input = buildToolSearchSpanInput(args);
    assert.equal(input.name, RUNTIME_TOOL_SEARCH);
    assert.equal(input.name, "runtime.tool_search");
    assert.deepEqual(input.metadata, {
      source: "model_search",
      caller: "boss",
      queryChars: 17,
    });
    assert.equal(input.input, undefined);
  });

  test("a hit records the candidate names, count, and a healthy latency band", () => {
    const { ended } = capture(() =>
      startToolSearchSpan(args).end({
        candidateNames: ["calendar.list_events", "calendar.get_event", "gmail.search"],
        latencyMs: 12,
      }),
    );
    assert.deepEqual(ended, [
      {
        status: "hit",
        metadata: {
          candidateCount: 3,
          candidateTools: "calendar.list_events,calendar.get_event,gmail.search",
          latencyMs: 12,
          latencyHealth: "ok",
        },
      },
    ]);
  });

  test("zero candidates is a miss, not an error (a discovery-metadata gap)", () => {
    const { ended } = capture(() =>
      startToolSearchSpan(args).end({ candidateNames: [], latencyMs: 40 }),
    );
    assert.deepEqual(ended, [
      {
        status: "miss",
        metadata: {
          candidateCount: 0,
          candidateTools: null,
          latencyMs: 40,
          latencyHealth: "yellow",
        },
      },
    ]);
  });

  test("a slow search degrades the latency band to red", () => {
    const { ended } = capture(() =>
      startToolSearchSpan(args).end({
        candidateNames: ["calendar.list_events", "gmail.search"],
        latencyMs: 150,
      }),
    );
    assert.equal(ended[0]?.metadata?.latencyHealth, "red");
  });

  test("the error path closes at ERROR and only the first close wins", () => {
    const { ended } = capture(() => {
      const span = startToolSearchSpan(args);
      span.error();
      span.end({ candidateNames: ["gmail.search"], latencyMs: 3 });
    });
    assert.deepEqual(ended, [{ status: "error", level: "ERROR" }]);
  });
});
