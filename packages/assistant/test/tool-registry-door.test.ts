/**
 * The tool-registry door on `@alfred/assistant/tool-runtime`.
 *
 * Two things are under test:
 *
 * 1. The barrel publishes the registration + lookup door, imported through the
 *    PACKAGE specifier. That spelling is what makes this a red-run detector for
 *    the `exports` seam — a manifest key that stops resolving fails here.
 * 2. The `exports` SELF-REFERENCE, and only that. Writers live in `@alfred/api`
 *    (`modules/tools/runtime.ts` registers the entries the definition files
 *    build with `liveTool`) while readers live in `@alfred/api` and
 *    `apps/server`, so the catalog crosses package roots. The last test
 *    registers through the package specifier and reads back through the relative
 *    `../src/tool-runtime/internal/registry` spelling. Be precise about what
 *    that pins: `packages/assistant` has no `node_modules` self-link, so Node
 *    resolves both spellings through this package's own `exports` map to the
 *    IDENTICAL file URL. The assertion therefore pins the manifest key — it goes
 *    red if `"./tool-runtime"` stops resolving to this file — and it CANNOT
 *    detect a module fork, because the two spellings cannot diverge here. The
 *    only real fork detector is at the bundle: exactly one copy of the registry
 *    module in `apps/server/dist`. Campaign item 103 owns that check.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as toolRuntimeBarrel from "@alfred/assistant/tool-runtime";
import {
  clearToolRegistryForTests,
  getTool,
  listRegisteredTools,
  liveTool,
  registerTool,
} from "@alfred/assistant/tool-runtime";
import { z } from "zod";
import {
  getTool as getToolRelative,
  listRegisteredTools as listRegisteredToolsRelative,
} from "../src/tool-runtime/internal/registry";

const TRANSITIONAL_REGISTRY_READERS = [
  "getTool",
  "listRegisteredTools",
  "listKernelTools",
  "listToolsForIntegration",
  "assertKernelToolsRegistered",
  "availableToolNames",
  "evaluateToolAvailability",
  "resolveToolAvailability",
  "readsAvailabilitySnapshot",
] as const;

const RETIRED_REGISTRY_READERS = [
  "evaluateToolRunContext",
  "evaluateToolCatalog",
  "singularizePhrase",
] as const;

function probeTool(action: "read_scratch" | "write_scratch") {
  return liveTool({
    integration: "system",
    action,
    riskTier: "no_risk",
    description: `Registry door probe for ${action}.`,
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  });
}

afterEach(() => {
  clearToolRegistryForTests();
});

test("the package door keeps only the transitional registry readers still in use", () => {
  const keys = new Set(Object.keys(toolRuntimeBarrel));

  for (const name of TRANSITIONAL_REGISTRY_READERS) {
    assert.ok(keys.has(name), `${name} must stay on the transitional reader door`);
  }
  for (const name of RETIRED_REGISTRY_READERS) {
    assert.ok(!keys.has(name), `${name} must leave the transitional reader door`);
  }
});

test("registerTool round-trips through getTool on the package specifier", () => {
  clearToolRegistryForTests();
  const tool = probeTool("read_scratch");

  registerTool(tool);

  assert.equal(getTool(tool.name), tool);
});

test("listRegisteredTools observes the write, so lookup and listing share one map", () => {
  clearToolRegistryForTests();
  const tool = probeTool("read_scratch");

  registerTool(tool);

  assert.deepEqual(
    listRegisteredTools().map((entry) => entry.name),
    [tool.name],
  );
});

test("a duplicate registration throws instead of overwriting the entry", () => {
  clearToolRegistryForTests();
  registerTool(probeTool("read_scratch"));

  assert.throws(() => registerTool(probeTool("read_scratch")), /duplicate registration/);
});

test("clearToolRegistryForTests empties the map", () => {
  clearToolRegistryForTests();
  registerTool(probeTool("read_scratch"));

  clearToolRegistryForTests();

  assert.deepEqual(listRegisteredTools(), []);
  assert.equal(getTool(probeTool("read_scratch").name), undefined);
});

test("the exports self-reference resolves both spellings to the same module", () => {
  clearToolRegistryForTests();
  const tool = probeTool("write_scratch");

  registerTool(tool);

  assert.equal(
    getToolRelative(tool.name),
    tool,
    "the package specifier no longer resolves to this file through the exports map",
  );
  assert.deepEqual(
    listRegisteredToolsRelative().map((entry) => entry.name),
    [tool.name],
  );
});
