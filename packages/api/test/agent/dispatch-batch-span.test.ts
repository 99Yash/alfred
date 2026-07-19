import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import type { DispatchResult } from "../../src/modules/dispatch";
import {
  RUNTIME_DISPATCH_BATCH,
  _setRuntimeSpanStarterForTests,
  buildDispatchBatchSpanInput,
  dispatchBatchEndMetadata,
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

describe("buildDispatchBatchSpanInput", () => {
  test("carries run id, the constant step id, workflow, caller, and call count under the stable name", () => {
    const startedAt = new Date("2026-07-14T12:00:00.000Z");
    const input = buildDispatchBatchSpanInput({
      runId: "run_1",
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
      // stepId is a constant of the contract, not caller-supplied.
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

describe("startDispatchBatchSpan closer", () => {
  // Capture what the batch closer forwards to the underlying runtime span so we
  // exercise the real emission path — the terminal vocabulary and the fold rule
  // that the workflows depend on, not a stand-alone deriver.
  const withSpan = (
    fn: (closer: ReturnType<typeof startDispatchBatchSpan>) => void,
  ): { opened: RuntimeSpanInput[]; ended: RuntimeSpanEndArgs[] } => {
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
      fn(
        startDispatchBatchSpan({
          runId: "run_2",
          workflow: "__chat-turn__",
          caller: "boss",
          callCount: 2,
          startedAt: new Date("2026-07-14T00:00:00.000Z"),
        }),
      );
    } finally {
      restore();
    }
    return { opened, ended };
  };

  test("routes the built input through the injected starter", () => {
    const { opened } = withSpan((closer) => closer.end("committed", [result("executed")]));
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.name, "runtime.dispatch.batch");
    assert.equal(opened[0]?.metadata?.caller, "boss");
    assert.equal(opened[0]?.metadata?.callCount, 2);
  });

  test("a non-error terminal folds the batch summary into end metadata at DEFAULT level", () => {
    const results = [result("executed"), result("executed")];
    const { ended } = withSpan((closer) => closer.end("committed", results));
    assert.deepEqual(ended, [
      {
        status: "committed",
        level: undefined,
        metadata: dispatchBatchEndMetadata(summarizeDispatchBatch(results)),
      },
    ]);
  });

  test("staged and parked terminals carry their own status with a folded summary", () => {
    const staged = withSpan((closer) => closer.end("staged", [result("staged")]));
    assert.equal(staged.ended[0]?.status, "staged");
    assert.equal(staged.ended[0]?.metadata?.staged, 1);

    const parked = withSpan((closer) => closer.end("parked", [result("parked")]));
    assert.equal(parked.ended[0]?.status, "parked");
    assert.equal(parked.ended[0]?.metadata?.parked, 1);
  });

  test("an error terminal records level ERROR and no summary", () => {
    const { ended } = withSpan((closer) => closer.end("error"));
    assert.deepEqual(ended, [{ status: "error", level: "ERROR", metadata: undefined }]);
  });

  test("only the first end closes the span (idempotent)", () => {
    const { ended } = withSpan((closer) => {
      closer.end("committed", [result("executed")]);
      closer.end("error"); // a later catch must not double-end
    });
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.status, "committed");
  });
});
