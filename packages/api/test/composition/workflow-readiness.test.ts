import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { toVerdict } from "../../src/composition/workflow-readiness";
import type { RuntimeReadinessResult } from "../../src/modules/workflows/runtime-readiness";
import type { WorkflowReadinessProblem } from "../../src/modules/workflows/readiness";

const problem: WorkflowReadinessProblem = {
  code: "needs_reauth",
  message: "Reconnect the Gmail account.",
  field: "gmail",
};

describe("composition readiness verdict mapping", () => {
  test("maps a ready result to the ready verdict", () => {
    const result: RuntimeReadinessResult = { kind: "ready" };
    assert.deepEqual(toVerdict(result), { kind: "ready" });
  });

  test("maps a deferred result and preserves its reason", () => {
    const result: RuntimeReadinessResult = { kind: "deferred", reason: "provider unhealthy" };
    assert.deepEqual(toVerdict(result), { kind: "deferred", reason: "provider unhealthy" });
  });

  test("maps a blocked result, forwards problems opaquely, and drops newlyBlocked", () => {
    const result: RuntimeReadinessResult = {
      kind: "blocked",
      problems: [problem],
      newlyBlocked: true,
    };
    const verdict = toVerdict(result);
    assert.deepEqual(verdict, { kind: "blocked", problems: [problem] });
    // The narrow verdict never carries newlyBlocked — the engine does not read it.
    assert.equal("newlyBlocked" in verdict, false);
    // Problems are forwarded by reference, unmodified.
    assert.equal(verdict.kind === "blocked" && verdict.problems[0], problem);
  });
});
