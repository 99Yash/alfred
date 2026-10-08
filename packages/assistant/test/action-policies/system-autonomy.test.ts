/**
 * `resolvePolicyMode` never gates `system.*` (ADR-0040 decision 5).
 * The check runs before the policy row read; only the second test fails if that order flips.
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

// With no `DATABASE_URL`, any policy row read throws, so a success proves no read happened.
delete process.env["DATABASE_URL"]; // drift-ok: the probe needs the variable ABSENT, which no presence guard expresses

const USER_ID = "usr_system_autonomy";

/** Gated at every level the policy editor offers. */
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
    // Correct: the ADR-0069 tier floor stages this tool, not the policy.
    assert.equal(await resolvePolicyMode(USER_ID, "system.activate_workflow"), "autonomy");

    // The rule must not swallow non-`system` tools.
    assert.equal(await resolvePolicyMode(USER_ID, "gmail.search"), "gated");
  });

  test("answers without reading the policy row — the check precedes the read", async () => {
    clearPolicyCacheForTests();

    assert.equal(await resolvePolicyMode(USER_ID, "system.read_user_context"), "autonomy");

    // Negative control: this process really cannot read a policy row.
    await assert.rejects(
      () => resolvePolicyMode(USER_ID, "gmail.search"),
      "a non-system resolution must fail with no DATABASE_URL, or this process is not read-free",
    );
  });
});
