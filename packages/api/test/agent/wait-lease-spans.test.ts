import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import {
  RUNTIME_APPROVAL_WAIT,
  RUNTIME_QUEUE_LEASE,
  RUNTIME_SUB_AGENT_WAIT,
  _setRuntimeSpanStarterForTests,
  buildApprovalWaitSpanInput,
  buildQueueLeaseSpanInput,
  buildSubAgentWaitSpanInput,
  startApprovalWaitSpan,
  startQueueLeaseSpan,
  startSubAgentWaitSpan,
} from "../../src/modules/agent/runtime-spans";

// Capture what a wait/lease closer forwards to the underlying runtime span, so
// the tests exercise the real emission path (built input + folded end metadata
// + level) without a live Langfuse client. Mirrors dispatch-batch-span.test.ts.
function capture(
  fn: (recorded: { opened: RuntimeSpanInput[]; ended: RuntimeSpanEndArgs[] }) => void,
): { opened: RuntimeSpanInput[]; ended: RuntimeSpanEndArgs[] } {
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
    fn({ opened, ended });
  } finally {
    restore();
  }
  return { opened, ended };
}

describe("runtime.approval.wait", () => {
  const args = {
    runId: "run_a",
    startedAt: new Date("2026-07-15T00:00:00.000Z"),
    toolName: "gmail.send",
    integration: "gmail",
    riskTier: "high",
  };

  test("builder carries the stable name and the bounded opening metadata", () => {
    const input = buildApprovalWaitSpanInput(args);
    assert.equal(input.name, RUNTIME_APPROVAL_WAIT);
    assert.equal(input.name, "runtime.approval.wait");
    assert.equal(input.runId, "run_a");
    assert.equal(input.startedAt, args.startedAt);
    assert.deepEqual(input.metadata, {
      toolName: "gmail.send",
      integration: "gmail",
      riskTier: "high",
    });
  });

  test("closer routes the built input through the injected starter and folds outcome + waitMs", () => {
    const endedAt = new Date("2026-07-15T00:00:05.000Z");
    const { opened, ended } = capture(() => {
      startApprovalWaitSpan(args).end("approved", endedAt);
    });
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.name, "runtime.approval.wait");
    // Expected, not an error: approval waits always close at DEFAULT (level unset).
    assert.deepEqual(ended, [
      { status: "approved", metadata: { outcome: "approved", waitMs: 5000 } },
    ]);
  });

  test("waitMs clamps to zero when the decision predates the request (clock skew)", () => {
    const { ended } = capture(() => {
      startApprovalWaitSpan(args).end("expired", new Date("2026-07-14T23:59:59.000Z"));
    });
    assert.equal(ended[0]?.metadata?.waitMs, 0);
  });

  test("only the first end closes the span (idempotent)", () => {
    const { ended } = capture(() => {
      const closer = startApprovalWaitSpan(args);
      closer.end("approved", new Date("2026-07-15T00:00:05.000Z"));
      closer.end("rejected", new Date("2026-07-15T00:00:09.000Z"));
    });
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.status, "approved");
  });
});

describe("runtime.sub_agent.wait", () => {
  const args = {
    runId: "parent_1",
    startedAt: new Date("2026-07-15T00:00:00.000Z"),
    childRunId: "child_1",
    parentStepId: "dispatch-tools",
  };

  test("builder carries the stable name and the child/step identity", () => {
    const input = buildSubAgentWaitSpanInput(args);
    assert.equal(input.name, RUNTIME_SUB_AGENT_WAIT);
    assert.equal(input.name, "runtime.sub_agent.wait");
    // Hangs under the PARENT trace.
    assert.equal(input.runId, "parent_1");
    assert.equal(input.startedAt, args.startedAt);
    assert.deepEqual(input.metadata, {
      childRunId: "child_1",
      parentStepId: "dispatch-tools",
    });
  });

  test("closer folds the child's terminal outcome + waitMs at DEFAULT level", () => {
    const { ended } = capture(() => {
      startSubAgentWaitSpan(args).end("failed", new Date("2026-07-15T00:00:12.000Z"));
    });
    assert.deepEqual(ended, [
      { status: "failed", metadata: { outcome: "failed", waitMs: 12_000 } },
    ]);
  });
});

describe("runtime.queue.lease", () => {
  const base = {
    runId: "run_q",
    workflow: "__chat-turn__",
    stepId: "boss-turn",
    leasedAt: new Date("2026-07-15T00:00:10.000Z"),
  };

  test("builder backdates the start by queueMs and carries the opening metadata", () => {
    const input = buildQueueLeaseSpanInput({
      ...base,
      fromStatus: "runnable",
      reclaimed: false,
      queueMs: 4000,
    });
    assert.equal(input.name, RUNTIME_QUEUE_LEASE);
    assert.equal(input.name, "runtime.queue.lease");
    // 10s lease minus 4s queue → start at 6s.
    assert.equal(input.startedAt.toISOString(), "2026-07-15T00:00:06.000Z");
    assert.deepEqual(input.metadata, {
      fromStatus: "runnable",
      workflow: "__chat-turn__",
      stepId: "boss-turn",
    });
  });

  test("a null queueMs (never checkpointed) anchors the start at the lease instant", () => {
    const input = buildQueueLeaseSpanInput({
      ...base,
      fromStatus: "pending",
      reclaimed: false,
      queueMs: null,
    });
    assert.equal(input.startedAt, base.leasedAt);
  });

  test("a normal lease closes at DEFAULT with reclaimed=false", () => {
    const { ended } = capture(() => {
      startQueueLeaseSpan({
        ...base,
        fromStatus: "runnable",
        reclaimed: false,
        queueMs: 4000,
      }).end();
    });
    assert.deepEqual(ended, [
      { status: "leased", level: "DEFAULT", metadata: { reclaimed: false, queueMs: 4000 } },
    ]);
  });

  test("a stale-lease reclaim closes at WARNING with reclaimed=true", () => {
    const { ended } = capture(() => {
      startQueueLeaseSpan({
        ...base,
        fromStatus: "running",
        reclaimed: true,
        queueMs: 90_000,
      }).end();
    });
    assert.deepEqual(ended, [
      { status: "reclaimed", level: "WARNING", metadata: { reclaimed: true, queueMs: 90_000 } },
    ]);
  });

  test("only the first end closes the span (idempotent)", () => {
    const { ended } = capture(() => {
      const closer = startQueueLeaseSpan({
        ...base,
        fromStatus: "runnable",
        reclaimed: false,
        queueMs: 1000,
      });
      closer.end();
      closer.end();
    });
    assert.equal(ended.length, 1);
  });
});
