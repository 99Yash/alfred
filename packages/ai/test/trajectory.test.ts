import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  canonicalize,
  diffTrajectories,
  extractTrajectory,
  stepKey,
  type TraceLike,
  type TraceObservation,
} from "../src/replay/trajectory";

/**
 * The replay-diff primitive answers "did my change move the trajectory, and
 * only where I intended" on real recorded runs. These pin extraction (ordering,
 * error status, decided-but-not-executed) and the paired diff (unchanged spine,
 * arg-change pairing, add/remove, order-insensitive args).
 */

function gen(output: unknown, startTime: string): TraceObservation {
  return { type: "GENERATION", name: "agent:chat", startTime, output };
}
function span(
  toolName: string,
  input: unknown,
  startTime: string,
  opts: { error?: string; toolCallId?: string } = {},
): TraceObservation {
  return {
    type: "SPAN",
    name: `tool:${toolName}`,
    startTime,
    input,
    level: opts.error ? "ERROR" : "DEFAULT",
    statusMessage: opts.error ?? null,
    metadata: opts.toolCallId ? { toolCallId: opts.toolCallId } : null,
  };
}

describe("canonicalize / stepKey", () => {
  test("key is insensitive to object key order", () => {
    assert.equal(
      stepKey({ toolName: "github.search", input: { q: "x", repo: "a" } }),
      stepKey({ toolName: "github.search", input: { repo: "a", q: "x" } }),
    );
  });
  test("canonicalize recurses into arrays and nested objects", () => {
    assert.deepEqual(canonicalize({ b: [{ y: 2, x: 1 }], a: 1 }), { a: 1, b: [{ x: 1, y: 2 }] });
  });
});

describe("extractTrajectory", () => {
  test("orders executed tool spans by start time and reads error status", () => {
    const trace: TraceLike = {
      id: "run_1",
      observations: [
        span("drive.search_files", { query: "SOW" }, "2026-06-26T01:00:02"),
        span("github.search", { q: "is:open" }, "2026-06-26T01:00:03", { error: "[github] 422" }),
        // out of order in the array — must sort by startTime
        span("system.read_user_context", { query: "client" }, "2026-06-26T01:00:01"),
      ],
    };
    const tj = extractTrajectory(trace);
    assert.deepEqual(
      tj.steps.map((s) => [s.toolName, s.status]),
      [
        ["system.read_user_context", "ok"],
        ["drive.search_files", "ok"],
        ["github.search", "error"],
      ],
    );
    assert.match(tj.steps[2]!.error!, /422/);
  });

  test("flags a decided call that never executed (staged / gated / rejected)", () => {
    const trace: TraceLike = {
      id: "run_2",
      observations: [
        // model decided to call two tools...
        gen(
          {
            toolCalls: [
              { toolName: "github.search", toolCallId: "c1", input: { q: "is:open" } },
              { toolName: "calendar.create_event", toolCallId: "c2", input: { title: "Sync" } },
            ],
          },
          "2026-06-26T01:00:01",
        ),
        // ...but only the search executed (the write was HIL-gated, no span).
        span("github.search", { q: "is:open" }, "2026-06-26T01:00:02", { toolCallId: "c1" }),
      ],
    };
    const tj = extractTrajectory(trace);
    assert.deepEqual(
      tj.steps.map((s) => s.toolName),
      ["github.search"],
    );
    assert.deepEqual(tj.decidedNotExecuted, [
      { toolName: "calendar.create_event", input: { title: "Sync" } },
    ]);
  });

  // The live-data regression (run_wdtn451w1zp0): the model tried calendar.list_events
  // three times; only the third ran, with SDK-injected `maxResults`. Matching by
  // canonical args wrongly flagged the executed one too. Match by toolCallId instead.
  test("matches decided→executed by toolCallId even when the args were transformed", () => {
    const trace: TraceLike = {
      id: "run_3",
      observations: [
        gen(
          {
            toolCalls: [
              {
                toolName: "calendar.list_events",
                toolCallId: "tc1",
                input: { timeframe: "today" },
              },
              {
                toolName: "calendar.list_events",
                toolCallId: "tc2",
                input: { timeMin: "2026-06-26T00:00:00Z", timeMax: "2026-06-26T23:59:59Z" },
              },
            ],
          },
          "t1",
        ),
        // Executed with an injected `maxResults` — args differ from the decision,
        // but the toolCallId matches tc2, so it must NOT be flagged.
        span(
          "calendar.list_events",
          { timeMin: "2026-06-26T00:00:00Z", timeMax: "2026-06-26T23:59:59Z", maxResults: 10 },
          "t2",
          { toolCallId: "tc2" },
        ),
      ],
    };
    const tj = extractTrajectory(trace);
    assert.deepEqual(tj.decidedNotExecuted, [
      { toolName: "calendar.list_events", input: { timeframe: "today" } },
    ]);
  });
});

describe("diffTrajectories", () => {
  const base = (): TraceLike => ({
    id: "base",
    observations: [
      span("system.read_user_context", { query: "client" }, "t1"),
      span("github.search", { q: "is:open" }, "t2"),
      span("drive.download_file", { id: "f1" }, "t3"),
    ],
  });

  test("identical runs → nothing moved", () => {
    const d = diffTrajectories(extractTrajectory(base()), extractTrajectory(base()));
    assert.equal(d.identical, true);
    assert.equal(d.unchanged.length, 3);
  });

  test("same tool, different args → reported as one change, not remove+add", () => {
    const cand: TraceLike = {
      id: "cand",
      observations: [
        span("system.read_user_context", { query: "client" }, "t1"),
        span("github.search", { q: "is:closed" }, "t2"), // arg changed
        span("drive.download_file", { id: "f1" }, "t3"),
      ],
    };
    const d = diffTrajectories(extractTrajectory(base()), extractTrajectory(cand));
    assert.equal(d.identical, false);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0]!.toolName, "github.search");
    assert.equal(d.added.length, 0);
    assert.equal(d.removed.length, 0);
    assert.equal(d.unchanged.length, 2);
  });

  test("an extra step in candidate is an addition; a dropped step is a removal", () => {
    const added: TraceLike = {
      id: "added",
      observations: [
        span("system.read_user_context", { query: "client" }, "t1"),
        span("github.search", { q: "is:open" }, "t2"),
        span("web.search", { q: "docs" }, "t2b"), // new step
        span("drive.download_file", { id: "f1" }, "t3"),
      ],
    };
    const d1 = diffTrajectories(extractTrajectory(base()), extractTrajectory(added));
    assert.deepEqual(
      d1.added.map((s) => s.toolName),
      ["web.search"],
    );
    assert.equal(d1.removed.length, 0);

    // reverse direction → removal
    const d2 = diffTrajectories(extractTrajectory(added), extractTrajectory(base()));
    assert.deepEqual(
      d2.removed.map((s) => s.toolName),
      ["web.search"],
    );
    assert.equal(d2.added.length, 0);
  });
});
