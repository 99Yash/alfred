import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { IntegrationAvailabilitySnapshot } from "@alfred/contracts";

import {
  clearToolRegistryForTests,
  evaluateToolAvailability,
  listRegisteredTools,
  readsAvailabilitySnapshot,
} from "../../src/modules/tools/registry";
import { registerBuiltinTools } from "../../src/modules/tools";

/**
 * `readsAvailabilitySnapshot` is what lets the dispatch floor answer a `system.*`
 * or `mcp.*` call without a credential read, and it necessarily RESTATES the
 * conditions phase 2 of the evaluator branches on. That duplication is the hazard
 * this file exists for: add a fourth snapshot gate, forget the predicate, and
 * every affected tool silently resolves `available: true` at the floor while
 * discovery still refuses it — surface and floor disagreeing, invisibly.
 *
 * So the promise is asserted mechanically, over the REAL registered catalog
 * rather than hand-written fixtures (which by construction cannot know about a
 * gate nobody wrote yet): for every tool the predicate excuses from the read, the
 * snapshot phase must resolve available against a snapshot with NOTHING in it —
 * the worst case the skipped read could have returned. A new gate that can reject
 * such a tool fails here.
 */

/** Nothing connected, nothing enabled: the harshest snapshot phase 2 can see. */
const EMPTY_SNAPSHOT: IntegrationAvailabilitySnapshot = {
  integrations: new Map(),
  providers: new Map(),
  passthroughEnabled: new Map(),
};

/**
 * Permissive on purpose. Phase 1 (allowlist / caller / thread) is not under test
 * here and this context clears all of it, so a failure below can only come from
 * the snapshot phase.
 */
const PERMISSIVE = { caller: "boss", hasThread: true } as const;

before(() => {
  clearToolRegistryForTests();
  registerBuiltinTools();
});

after(() => {
  clearToolRegistryForTests();
});

describe("skipping the credential read is a promise phase 2 keeps", () => {
  test("every tool excused from the snapshot read resolves available without one", () => {
    const excused = listRegisteredTools().filter((tool) => !readsAvailabilitySnapshot(tool));
    assert.ok(excused.length > 0, "expected some tools to skip the read — otherwise vacuous");

    for (const tool of excused) {
      const result = evaluateToolAvailability(EMPTY_SNAPSHOT, tool, new Set(), PERMISSIVE);
      assert.equal(
        result.available,
        true,
        `'${tool.name}' skips the credential read at the dispatch floor but the snapshot gates ` +
          `would have refused it (${result.available ? "" : `${result.code}: ${result.reason}`}) — ` +
          "a snapshot gate was added without updating `readsAvailabilitySnapshot`",
      );
    }
  });

  test("the excused set is exactly the integrations absent from the snapshot", () => {
    // Documents WHY they are excused: `system` has no credential, and `mcp`
    // connection health lives on `mcp_connections`, not `integration_credentials`.
    const excusedIntegrations = new Set(
      listRegisteredTools()
        .filter((tool) => !readsAvailabilitySnapshot(tool))
        .map((tool) => tool.integration),
    );
    assert.deepEqual([...excusedIntegrations].sort(), ["mcp", "system"]);
  });

  test("a credential-bearing tool is NOT excused — it must pay the read", () => {
    const gmail = listRegisteredTools().filter((tool) => tool.integration === "gmail");
    assert.ok(gmail.length > 0);
    for (const tool of gmail) assert.equal(readsAvailabilitySnapshot(tool), true);
  });
});
