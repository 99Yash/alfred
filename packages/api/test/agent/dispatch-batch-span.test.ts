import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import type { DispatchResult } from "../../src/modules/dispatch";
import {
  RUNTIME_DISPATCH_BATCH,
  _setRuntimeSpanStarterForTests,
  buildDispatchBatchSpanInput,
  dispatchBatchEndMetadata,
  dispatchBatchStatus,
  startDispatchBatchSpan,
  summarizeDispatchBatch,
} from "../../src/modules/agent/runtime-spans";

// The batch helpers only read `.kind`, so a minimal typed literal is enough to
// exercise the summary buckets without a live registry/dispatch (mirrors the
// reissue-narration test's `result()` helper).
const result = (kind: DispatchResult["kind"]): DispatchResult => ({ kind }) as DispatchResult;

describe("summarizeDispatchBatch", () => {
  test("tallies each outcome and counts every slot toward callCount", () => {
    const summary = summarizeDispatchBatch([
      result("executed"),
      result("executed"),
      result("failed"),
      result("inactive_tool"),
      result("rejected"),
      undefined, // undispatched gated sibling — callCount only
    ]);
    assert.equal(summary.callCount, 6);
    assert.equal(summary.executed, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.inactiveTool, 1);
    assert.equal(summary.rejected, 1);
    // Untouched buckets stay zero.
    assert.equal(summary.staged, 0);
    assert.equal(summary.parked, 0);
    assert.equal(summary.invalidInput, 0);
    assert.equal(summary.unknownTool, 0);
    assert.equal(summary.notAllowed, 0);
  });

  test("an empty batch is all zeros", () => {
    const summary = summarizeDispatchBatch([]);
    assert.equal(summary.callCount, 0);
    assert.equal(summary.executed, 0);
  });
});

describe("dispatchBatchStatus", () => {
  const zero = summarizeDispatchBatch([]);

  test("staging wins over a sub-agent park and a plain commit", () => {
    assert.equal(dispatchBatchStatus({ ...zero, staged: 1, parked: 1 }), "staged");
  });

  test("a sub-agent park with no stage reports parked", () => {
    assert.equal(dispatchBatchStatus({ ...zero, parked: 1 }), "parked");
  });

  test("everything else is committed", () => {
    assert.equal(dispatchBatchStatus({ ...zero, executed: 3, failed: 1 }), "committed");
  });
});

describe("buildDispatchBatchSpanInput", () => {
  test("carries run id, step id, workflow, caller, and call count under the stable name", () => {
    const startedAt = new Date("2026-07-14T12:00:00.000Z");
    const input = buildDispatchBatchSpanInput({
      runId: "run_1",
      stepId: "dispatch-tools",
      workflow: "__user-authored-brief__",
      caller: "sub:research-1",
      callCount: 4,
      startedAt,
    });
    assert.equal(input.name, RUNTIME_DISPATCH_BATCH);
    assert.equal(input.name, "runtime.dispatch.batch");
    assert.equal(input.runId, "run_1");
    assert.equal(input.startedAt, startedAt);
    assert.deepEqual(input.metadata, {
      stepId: "dispatch-tools",
      workflow: "__user-authored-brief__",
      caller: "sub:research-1",
      callCount: 4,
    });
  });
});

describe("dispatchBatchEndMetadata", () => {
  test("projects the summary to a flat count map (no callCount, no raw values)", () => {
    const summary = summarizeDispatchBatch([result("executed"), result("staged")]);
    assert.deepEqual(dispatchBatchEndMetadata(summary), {
      executed: 1,
      staged: 1,
      parked: 0,
      rejected: 0,
      invalidInput: 0,
      unknownTool: 0,
      inactiveTool: 0,
      notAllowed: 0,
      failed: 0,
    });
  });
});

describe("startDispatchBatchSpan", () => {
  test("routes the built input through the injected starter and forwards end args", () => {
    const opened: RuntimeSpanInput[] = [];
    const ended: RuntimeSpanEndArgs[] = [];
    const restore = _setRuntimeSpanStarterForTests((input) => {
      opened.push(input);
      return {
        end(args) {
          ended.push(args);
        },
      };
    });
    try {
      const closer = startDispatchBatchSpan({
        runId: "run_2",
        stepId: "dispatch-tools",
        workflow: "__chat-turn__",
        caller: "boss",
        callCount: 2,
        startedAt: new Date("2026-07-14T00:00:00.000Z"),
      });
      closer.end({ status: "committed", metadata: { executed: 2 } });

      assert.equal(opened.length, 1);
      assert.equal(opened[0]?.name, "runtime.dispatch.batch");
      assert.equal(opened[0]?.metadata?.caller, "boss");
      assert.equal(opened[0]?.metadata?.callCount, 2);
      assert.deepEqual(ended, [{ status: "committed", metadata: { executed: 2 } }]);
    } finally {
      restore();
    }
  });
});
