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
 * `toolCallWouldGate` is the scheduling hint chat-turn's batch dispatch uses to
 * keep gated writes out of the concurrent bucket (perf/191-195 HIL fix). It
 * mirrors two of the three things `dispatchToolCall` decides with — the resolved
 * policy mode and the tool's STATIC risk tier — so a tool that would stage must
 * not run in parallel with another one.
 *
 * The whole file is DB-free. The first two suites need no policy row at all:
 * `resolvePolicyMode` answers `"autonomy"` for `system.*` before it reads
 * anything (ADR-0040 as amended), and an unregistered name is refused by
 * `isToolName` first. The registry-wide mirror suite primes the cache instead.
 *
 * The first suite MUST register the builtins. Without them the registry is
 * empty, `toolCallWouldGate` returns at its `if (!tool) return false` guard, and
 * every assertion below passes without reading a policy mode or a risk tier —
 * green and vacuous. Each suite that names a real tool therefore asserts the
 * registry is populated first.
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
 * The property, over every registered tool: the hint and the gate cannot
 * disagree. "The two happen to agree today" is exactly the state that rots, so
 * this is the check that fails the moment they part.
 *
 * It mirrors the policy + STATIC tier gate. It deliberately does NOT mirror two
 * other things, and both are stated in the assertion rather than exempted:
 *
 *   - a tool with `resolveRiskTier` reports `true` unconditionally, because the
 *     hint holds no validated input. That is a documented conservative
 *     over-report, not a mirror.
 *   - the `staging: "fast_path"` route returns from `dispatchToolCall` BEFORE the
 *     gate, so the hint over-reports for `mcp.list_tools` (campaign item 181).
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
        const expected = tool.resolveRiskTier
          ? true
          : toolRequiresApproval(await resolvePolicyMode(MIRROR_USER_ID, tool.name), tool.riskTier);
        assert.equal(
          await toolCallWouldGate(MIRROR_USER_ID, tool.name),
          expected,
          `${tool.name} (riskTier=${tool.riskTier}, defaultMode=${defaultMode})`,
        );
      }
    });
  }

  /**
   * The one behavior this change flips, named so a later reader does not take it
   * for a regression. `system.activate_workflow` is registered `riskTier: "high"`
   * and ADR-0069 makes `high` a hard approval floor that autonomy cannot
   * override, so `dispatchToolCall` stages it — the tool is the editable approval
   * contract. Before this change the hint answered `false` for it, and the
   * concurrent bucket could stage a SECOND approval card beside the serial one.
   */
  test("system.activate_workflow gates — the ADR-0069 high-tier floor outranks system autonomy", async () => {
    clearToolRegistryForTests();
    registerBuiltinTools();
    clearPolicyCacheForTests();
    _primePolicyCacheForTests(policy("autonomy"));

    assert.equal(await toolCallWouldGate(MIRROR_USER_ID, "system.activate_workflow"), true);
  });
});
