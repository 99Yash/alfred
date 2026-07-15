import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ToolName } from "@alfred/contracts";
import {
  applyExactToolLoad,
  applySystemToolEffect,
  migrateActiveTools,
  registeredToolNamesForIntegrations,
  systemToolKernel,
} from "../../src/modules/agent/tool-surface";
import { registerBuiltinTools } from "../../src/modules/tools/index";
import { clearToolRegistryForTests, getTool, listKernelTools } from "../../src/modules/tools/registry";

/**
 * Regression coverage for the run-local tool surface + persisted-state
 * migration (#405/#411/#412). The load-bearing property: a run checkpointed
 * before a deploy — whose active or pending set may still name a tool that has
 * since been retired (here `system.load_integration`, dropped when
 * integration-level loading was replaced by exact `system.load_tool`) —
 * migrates forward gracefully by DROPPING the unknown name rather than carrying
 * a dangling tool the dispatcher can no longer resolve.
 */

// A plausibly-persisted name that is no longer a registered tool: not present in
// INTEGRATION_ACTIONS['system'], so `isToolName` rejects it before the registry
// lookup even runs.
const RETIRED_TOOL = "system.load_integration";

before(() => {
  clearToolRegistryForTests();
  registerBuiltinTools();
});

after(() => clearToolRegistryForTests());

describe("systemToolKernel", () => {
  test("mirrors the registered kernel surface and every entry is a kernel system tool", () => {
    const kernel = systemToolKernel();
    assert.ok(kernel.length > 0, "kernel must be non-empty");
    assert.deepEqual(
      [...kernel].sort(),
      listKernelTools()
        .map((tool) => tool.name)
        .sort(),
    );
    for (const name of kernel) {
      const tool = getTool(name);
      assert.ok(tool, `kernel tool ${name} must be registered`);
      assert.equal(tool?.integration, "system");
      assert.equal(tool?.availability?.surface, "kernel");
    }
  });
});

describe("migrateActiveTools", () => {
  test("new-format checkpoint drops a retired tool and keeps + sorts the rest", () => {
    const migrated = migrateActiveTools(
      [RETIRED_TOOL, "system.load_tool", "gmail.search"],
      undefined,
      [],
    );
    assert.deepEqual(migrated, ["gmail.search", "system.load_tool"]);
    assert.ok(!(migrated as string[]).includes(RETIRED_TOOL));
  });

  test("new-format checkpoint dedupes repeated names", () => {
    const migrated = migrateActiveTools(
      ["gmail.search", "gmail.search", "system.load_tool"],
      undefined,
      [],
    );
    assert.deepEqual(migrated, ["gmail.search", "system.load_tool"]);
  });

  test("an empty new-format checkpoint is authoritative — it does not re-seed the kernel", () => {
    assert.deepEqual(migrateActiveTools([], undefined, []), []);
  });

  test("legacy expansion drops a retired pending name but keeps kernel + integration tools", () => {
    const migrated = migrateActiveTools(undefined, ["gmail"], [RETIRED_TOOL]);
    assert.ok(!(migrated as string[]).includes(RETIRED_TOOL), "retired pending name is dropped");
    for (const name of systemToolKernel()) {
      assert.ok(migrated.includes(name), `kernel tool ${name} retained`);
    }
    for (const name of registeredToolNamesForIntegrations(["gmail"])) {
      assert.ok(migrated.includes(name), `gmail tool ${name} retained`);
    }
  });

  test("legacy expansion unions a valid pending tool from outside the active integrations", () => {
    const migrated = migrateActiveTools(undefined, ["gmail"], ["calendar.list_events"]);
    assert.ok(migrated.includes("calendar.list_events"));
  });

  test("empty legacy state yields exactly the kernel", () => {
    const migrated = migrateActiveTools(undefined, undefined, []);
    assert.deepEqual([...migrated].sort(), [...systemToolKernel()].sort());
  });
});

describe("applyExactToolLoad", () => {
  const base: ToolName[] = ["gmail.search"];

  test("adds a valid loaded tool", () => {
    assert.deepEqual(applyExactToolLoad(base, { ok: true, name: "calendar.list_events" }), [
      "calendar.list_events",
      "gmail.search",
    ]);
  });

  test("ignores a retired tool name that is unknown to the registry", () => {
    assert.deepEqual(applyExactToolLoad(base, { ok: true, name: RETIRED_TOOL }), ["gmail.search"]);
  });

  test("ignores a non-ok or malformed effect", () => {
    assert.deepEqual(applyExactToolLoad(base, { ok: false, name: "calendar.list_events" }), [
      "gmail.search",
    ]);
    assert.deepEqual(applyExactToolLoad(base, "nope"), ["gmail.search"]);
    assert.deepEqual(applyExactToolLoad(base, null), ["gmail.search"]);
  });
});

describe("applySystemToolEffect", () => {
  test("a successful load_tool folds the new tool into the active set", () => {
    const state: { activeTools: ToolName[] } = { activeTools: ["gmail.search"] };
    applySystemToolEffect(state, "system.load_tool", {
      kind: "executed",
      toolResult: { ok: true, name: "calendar.list_events" },
    });
    assert.ok(state.activeTools.includes("calendar.list_events"));
  });

  test("a load_tool naming a retired tool leaves the active set unchanged", () => {
    const state: { activeTools: ToolName[] } = { activeTools: ["gmail.search"] };
    applySystemToolEffect(state, "system.load_tool", {
      kind: "executed",
      toolResult: { ok: true, name: RETIRED_TOOL },
    });
    assert.deepEqual(state.activeTools, ["gmail.search"]);
  });

  test("a non-load system tool is inert", () => {
    const state: { activeTools: ToolName[] } = { activeTools: ["gmail.search"] };
    applySystemToolEffect(state, "system.current_time", {
      kind: "executed",
      toolResult: { some: "snapshot" },
    });
    assert.deepEqual(state.activeTools, ["gmail.search"]);
  });

  test("a non-executed load_tool result is inert", () => {
    const state: { activeTools: ToolName[] } = { activeTools: ["gmail.search"] };
    applySystemToolEffect(state, "system.load_tool", {
      kind: "staged",
      toolResult: { ok: true, name: "calendar.list_events" },
    });
    assert.deepEqual(state.activeTools, ["gmail.search"]);
  });
});
