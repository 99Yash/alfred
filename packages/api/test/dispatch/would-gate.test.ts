import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { toolCallWouldGate, toolRequiresApproval } from "../../src/modules/dispatch";

/**
 * `toolCallWouldGate` is the scheduling hint chat-turn's batch dispatch uses to
 * keep gated writes out of the concurrent bucket (perf/191-195 HIL fix): a
 * non-`system` tool stages when its policy resolves to `gated` OR it is a
 * high-tier tool (the ADR-0069 floor), so everything else must be reported as
 * non-gating and stay parallel. The two branches asserted here are the DB-free
 * ones — they short-circuit *before* any policy lookup, so they pin the
 * load-bearing invariant (system + unknown tools never gate) without a database.
 * The policy/tier-driven branch is exercised by the DB-backed dispatcher suite.
 */
describe("toolCallWouldGate", () => {
  const userId = "test-would-gate-user";

  test("system tools never gate — they stay in the concurrent bucket", async () => {
    for (const name of [
      "system.read_user_context",
      "system.spawn_sub_agent",
      "system.load_integration",
      "system.remember",
    ]) {
      assert.equal(await toolCallWouldGate(userId, name), false, name);
    }
  });

  test("unknown tool names never gate", async () => {
    assert.equal(await toolCallWouldGate(userId, "bogus.not_a_tool"), false);
    assert.equal(await toolCallWouldGate(userId, "list_events"), false);
  });
});

/**
 * The pure gate predicate (ADR-0069). `high` tier is a one-way floor: it always
 * confirms even under an autonomy policy; the lower tiers are policy-driven.
 */
describe("toolRequiresApproval", () => {
  test("high tier always confirms, regardless of policy mode", () => {
    assert.equal(toolRequiresApproval("autonomy", "high"), true);
    assert.equal(toolRequiresApproval("gated", "high"), true);
  });

  test("lower tiers follow the policy mode", () => {
    for (const tier of ["no_risk", "low", "medium"] as const) {
      assert.equal(toolRequiresApproval("autonomy", tier), false, `autonomy/${tier}`);
      assert.equal(toolRequiresApproval("gated", tier), true, `gated/${tier}`);
    }
  });
});
