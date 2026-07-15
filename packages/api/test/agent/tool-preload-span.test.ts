import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import {
  RUNTIME_TOOL_PRELOAD,
  _setRuntimeSpanStarterForTests,
  buildToolPreloadSpanInput,
  startToolPreloadSpan,
} from "../../src/modules/agent/runtime-spans";

function capture(run: () => void): { opened: RuntimeSpanInput[]; ended: RuntimeSpanEndArgs[] } {
  const opened: RuntimeSpanInput[] = [];
  const ended: RuntimeSpanEndArgs[] = [];
  const restore = _setRuntimeSpanStarterForTests((input) => {
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

describe("runtime.tool.preload", () => {
  const args = {
    runId: "run_preload",
    workflow: "__chat-turn__",
    caller: "boss",
    activeBefore: 8,
    allowedIntegrationCount: 3,
    promptChars: 42,
    startedAt: new Date("2026-07-15T00:00:00.000Z"),
  };

  test("records bounded review metadata without raw prompt content", () => {
    const input = buildToolPreloadSpanInput(args);
    assert.equal(input.name, RUNTIME_TOOL_PRELOAD);
    assert.equal(input.name, "runtime.tool.preload");
    assert.equal(input.runId, "run_preload");
    assert.equal(input.startedAt, args.startedAt);
    assert.deepEqual(input.metadata, {
      workflow: "__chat-turn__",
      caller: "boss",
      activeBefore: 8,
      allowedIntegrationCount: 3,
      promptChars: 42,
    });
    assert.equal(input.input, undefined);
  });

  test("reports selected canonical names and the resulting surface size", () => {
    const { opened, ended } = capture(() => {
      startToolPreloadSpan(args).end(["calendar.list_events", "calendar.get_event"], 10);
    });
    assert.equal(opened.length, 1);
    assert.deepEqual(ended, [
      {
        status: "selected",
        metadata: {
          selectedCount: 2,
          selectedTools: "calendar.list_events,calendar.get_event",
          activeAfter: 10,
        },
      },
    ]);
  });

  test("distinguishes no-match from errors and closes only once", () => {
    const noMatch = capture(() => startToolPreloadSpan(args).end([], 8));
    assert.deepEqual(noMatch.ended, [
      {
        status: "no_match",
        metadata: { selectedCount: 0, selectedTools: null, activeAfter: 8 },
      },
    ]);

    const failed = capture(() => {
      const span = startToolPreloadSpan(args);
      span.error();
      span.end(["gmail.search"], 9);
    });
    assert.deepEqual(failed.ended, [{ status: "error", level: "ERROR" }]);
  });
});
