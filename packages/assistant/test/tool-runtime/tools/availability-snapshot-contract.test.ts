import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { IntegrationAvailabilitySnapshot } from "@alfred/contracts";

import { clearToolRegistryForTests } from "@alfred/assistant/tool-runtime";
import {
  evaluateToolAvailability,
  listRegisteredTools,
  readsAvailabilitySnapshot,
} from "../../../src/tool-runtime/internal/registry";
import { registerBuiltinTools } from "../../../src/tool-runtime/builtin-tools";

/**
 * `readsAvailabilitySnapshot` restates the snapshot gates so the floor can skip the read.
 * A new gate without a matching predicate change would let the floor and discovery disagree.
 * So every excused tool in the real catalog must resolve available against an empty snapshot.
 */

/** Nothing connected and nothing enabled: the worst case. */
const EMPTY_SNAPSHOT: IntegrationAvailabilitySnapshot = {
  integrations: new Map(),
  providers: new Map(),
  passthroughEnabled: new Map(),
};

/** Clears phase 1, so a failure can only come from the snapshot phase. */
const PERMISSIVE = { caller: "boss", interaction: "live_chat" } as const;

/** `system.code_run` clears phase 1 only in a `code_run` run (ADR-0124: the pin rules the run). */
const SCRIPT_READS = { ...PERMISSIVE, readPath: "code_run" } as const;

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
      const context = tool.availability?.codeModeReadPath ? SCRIPT_READS : PERMISSIVE;
      const result = evaluateToolAvailability(EMPTY_SNAPSHOT, tool, new Set(), context);
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
    // `system` has no credential. `mcp` health lives on `mcp_connections`.
    const excusedIntegrations = new Set(
      listRegisteredTools()
        .filter((tool) => !readsAvailabilitySnapshot(tool))
        .map((tool) => tool.integration),
    );

    assert.deepEqual([...excusedIntegrations].toSorted(), ["mcp", "system"]);
  });

  test("an integration tool is NOT excused — it must pay the read", () => {
    // No registered tool names a credential since `gmail.send_draft` went (drafts only,
    // owner 2026-11-15). A loadable integration still pays the read.
    const sheets = listRegisteredTools().filter((tool) => tool.integration === "sheets");
    assert.ok(sheets.length > 0);

    for (const tool of sheets) assert.equal(readsAvailabilitySnapshot(tool), true);
  });
});
