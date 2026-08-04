import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import {
  RUNTIME_TOOL_SEARCH,
  _setRuntimeSpanStarterForTests,
  buildToolSearchSpanInput,
  startToolSearchSpan,
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
});
