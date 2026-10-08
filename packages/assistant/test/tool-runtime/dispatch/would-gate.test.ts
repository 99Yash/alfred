import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { ResolvedPolicy } from "@alfred/assistant/action-policies";
import {
  DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
  resolvePolicyMode,
} from "@alfred/assistant/action-policies";
import {
  _primePolicyCacheForTests,
  clearPolicyCacheForTests,
} from "@alfred/assistant/action-policies/test-support";
import { clearToolRegistryForTests } from "@alfred/assistant/tool-runtime";

import { registerBuiltinTools } from "../../../src/tool-runtime/builtin-tools";
import { listRegisteredTools } from "../../../src/tool-runtime/internal/registry";
import {
  toolCallWouldGate,
  toolRequiresApproval,
} from "../../../src/tool-runtime/internal/dispatch";

/**
 * `toolCallWouldGate` keeps gated calls out of the concurrent batch. It mirrors the
 * policy mode and the static risk tier. DB-free: `system.*` resolves to autonomy without a read.
 * Register the builtins first. An empty registry makes every assertion pass vacuously.
 */
describe("toolCallWouldGate", () => {
  const userId = "test-would-gate-user";

  before(() => {
    clearToolRegistryForTests();
    registerBuiltinTools();
  });

  after(() => {
    clearToolRegistryForTests();
  });

  test("no_risk system tools never gate — they stay in the concurrent bucket", async () => {
    assert.ok(
      listRegisteredTools().length > 0,
      "the registry must be populated or this asserts nothing",
    );

    for (const name of [
      "system.read_user_context",
      "system.spawn_sub_agent",
      "system.load_tool",
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

/** `high` always confirms, even under autonomy. Lower tiers follow the policy (ADR-0069). */
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

const MIRROR_USER_ID = "test-would-gate-mirror-user";

function policy(defaultMode: ResolvedPolicy["defaultMode"]): ResolvedPolicy {
  return {
    userId: MIRROR_USER_ID,
    defaultMode,
    integrationRules: {},
    approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
  };
}

/**
 * The hint and the gate must agree for every registered tool. Two known over-reports:
 * a `resolveRiskTier` tool (the hint has no validated input) and a `fast_path` tool,
 * which returns before the gate. A `question` tool stages under both modes (ADR-0099).
 */
describe("toolCallWouldGate mirrors the dispatch gate for every registered tool", () => {
  after(() => {
    clearToolRegistryForTests();
    clearPolicyCacheForTests();
  });

  for (const defaultMode of ["gated", "autonomy"] as const) {
    test(`under a ${defaultMode} policy`, async () => {
      clearToolRegistryForTests();
      registerBuiltinTools();
      clearPolicyCacheForTests();
      _primePolicyCacheForTests(policy(defaultMode));

      const tools = listRegisteredTools();
      assert.ok(tools.length > 0, "the registry must be populated or this asserts nothing");

      for (const tool of tools) {
        const expected =
          tool.resolveRiskTier || tool.staging === "question"
            ? true
            : toolRequiresApproval(
                await resolvePolicyMode(MIRROR_USER_ID, tool.name),
                tool.riskTier,
              );

        assert.equal(
          await toolCallWouldGate(MIRROR_USER_ID, tool.name),
          expected,
          `${tool.name} (riskTier=${tool.riskTier}, defaultMode=${defaultMode})`,
        );
      }
    });
  }

  /** A `false` here would let the concurrent batch stage a second approval card. */
  test("system.activate_workflow gates — the ADR-0069 high-tier floor outranks system autonomy", async () => {
    clearToolRegistryForTests();
    registerBuiltinTools();
    clearPolicyCacheForTests();
    _primePolicyCacheForTests(policy("autonomy"));

    assert.equal(await toolCallWouldGate(MIRROR_USER_ID, "system.activate_workflow"), true);
  });
});
