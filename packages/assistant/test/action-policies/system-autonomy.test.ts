/**
 * `system.*` is structurally non-gateable, and `resolvePolicyMode` is where that
 * rule lives (ADR-0040 decision 5, amended 2026-08-13).
 *
 * Both invariants asserted here are DB-free, and that is the point of the file:
 *
 *   1. The resolver's own answer beats every data-layer answer — a `gated`
 *      integration rule and a per-tool `gated` override both lose.
 *   2. The check runs BEFORE the policy row read. Order is load-bearing. Put the
 *      `system` branch after `await getResolvedPolicy(userId)` and every
 *      assertion in this repo still passes wherever a database exists; the
 *      second test below is the only one that fires on the wrong order.
 *
 * Two DB-free dispatch suites (`tool-runtime/dispatch/staging-machine.test.ts`,
 * `tool-runtime/dispatch/would-gate.test.ts`) depend on that ordering, because a
 * `system.*` dispatch must perform zero policy reads.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { ResolvedPolicy } from "@alfred/assistant/action-policies";
import {
  resolvePolicyMode,
  DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
} from "@alfred/assistant/action-policies";
import {
  _primePolicyCacheForTests,
  clearPolicyCacheForTests,
} from "@alfred/assistant/action-policies/test-support";

// `db()` builds its pool from `databaseEnv()`, which rejects an absent
// `DATABASE_URL`. Removing the variable for this whole file makes ANY policy row
// read throw, which is what turns the second test below into proof: a successful
// `system.*` resolution means no read was attempted, not that a read succeeded.
// Every assertion here is DB-free by design, so nothing in the file needs it back.
delete process.env["DATABASE_URL"]; // drift-ok: the probe needs the variable ABSENT, which no presence guard expresses

const USER_ID = "usr_system_autonomy";

/**
 * The harshest data-layer answer the policy editor can produce: gated by
 * default, gated for the whole `system` integration, and gated again by a
 * per-tool override — the branch that wins first in the read order.
 */
const HOSTILE_POLICY: ResolvedPolicy = {
  userId: USER_ID,
  defaultMode: "gated",
  integrationRules: {
    system: {
      mode: "gated",
      toolOverrides: { "system.read_user_context": "gated" },
    },
  },
  approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
};

describe("resolvePolicyMode — the system.* autonomy rule", () => {
  afterEach(() => clearPolicyCacheForTests());

  test("beats a gated default, a gated integration rule and a gated tool override", async () => {
    _primePolicyCacheForTests(HOSTILE_POLICY);

    assert.equal(await resolvePolicyMode(USER_ID, "system.read_user_context"), "autonomy");
    // The `high`-tier system tool resolves to `autonomy` too. That is correct:
    // what stages `system.activate_workflow` is the ADR-0069 tier floor, which
    // `toolRequiresApproval` ORs with this mode — never the user's policy.
    assert.equal(await resolvePolicyMode(USER_ID, "system.activate_workflow"), "autonomy");

    // The guard that the rule is scoped to `system` and did not swallow the
    // whole policy read: a non-`system` tool still answers from the row.
    assert.equal(await resolvePolicyMode(USER_ID, "gmail.search"), "gated");
  });

  test("answers without reading the policy row — the check precedes the read", async () => {
    clearPolicyCacheForTests();

    assert.equal(await resolvePolicyMode(USER_ID, "system.read_user_context"), "autonomy");

    // The negative control. Without it the assertion above proves nothing: it
    // would also pass if this process could read a policy row.
    await assert.rejects(
      () => resolvePolicyMode(USER_ID, "gmail.search"),
      "a non-system resolution must fail with no DATABASE_URL, or this process is not read-free",
    );
  });
});
