import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  checkWorkflowReadiness,
  registerWorkflowReadinessCheck,
  type WorkflowReadinessVerdict,
} from "../../src/modules/agent/workflows/readiness-port";

const ready: WorkflowReadinessVerdict = { kind: "ready" };

describe("workflow readiness port", () => {
  test("throws a loud [agent] error when no check is registered", async () => {
    await assert.rejects(
      () => checkWorkflowReadiness({ runId: "run-1", userId: "user-1" }),
      /\[agent\] no workflow readiness check is registered/,
    );
  });

  test("forwards args to the registered check and returns its verdict", async () => {
    const seen: { runId: string; userId: string }[] = [];
    const unregister = registerWorkflowReadinessCheck(async (args) => {
      seen.push(args);
      return { kind: "blocked", problems: [{ code: "needs_reauth" }] };
    });

    try {
      const verdict = await checkWorkflowReadiness({ runId: "run-2", userId: "user-2" });
      assert.deepEqual(seen, [{ runId: "run-2", userId: "user-2" }]);
      assert.deepEqual(verdict, { kind: "blocked", problems: [{ code: "needs_reauth" }] });
    } finally {
      unregister();
    }
  });

  test("rejects a second registration while one is live", () => {
    const unregister = registerWorkflowReadinessCheck(async () => ready);

    try {
      assert.throws(
        () => registerWorkflowReadinessCheck(async () => ready),
        /\[agent\] a workflow readiness check is already registered/,
      );
    } finally {
      unregister();
    }
  });

  test("unregister clears the check and lets a fresh one register", async () => {
    const unregister = registerWorkflowReadinessCheck(async () => ready);
    unregister();

    // Once cleared, the live call throws again...
    await assert.rejects(
      () => checkWorkflowReadiness({ runId: "run-3", userId: "user-3" }),
      /no workflow readiness check is registered/,
    );

    // ...and a re-registration succeeds rather than colliding.
    const reregister = registerWorkflowReadinessCheck(async () => ({
      kind: "deferred",
      reason: "provider warming up",
    }));
    try {
      assert.deepEqual(await checkWorkflowReadiness({ runId: "run-4", userId: "user-4" }), {
        kind: "deferred",
        reason: "provider warming up",
      });
    } finally {
      reregister();
    }
  });

  test("a stale unregister after re-registration does not clear the new check", async () => {
    const unregisterFirst = registerWorkflowReadinessCheck(async () => ready);
    unregisterFirst();
    const unregisterSecond = registerWorkflowReadinessCheck(async () => ({
      kind: "blocked",
      problems: [],
    }));

    try {
      // The first unregister is a no-op now — it only clears its own closure.
      unregisterFirst();
      assert.deepEqual(await checkWorkflowReadiness({ runId: "run-5", userId: "user-5" }), {
        kind: "blocked",
        problems: [],
      });
    } finally {
      unregisterSecond();
    }
  });
});
