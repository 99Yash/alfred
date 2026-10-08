/**
 * `@alfred/assistant/tool-runtime` publishes the registration door through the package specifier.
 * Both spellings resolve to the same file here, so this pins the `exports` key; it cannot see a module fork.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as toolRuntimeBarrel from "@alfred/assistant/tool-runtime";
import { clearToolRegistryForTests, liveTool, registerTool } from "@alfred/assistant/tool-runtime";
import { z } from "zod";
import {
  getTool,
  getTool as getToolRelative,
  listRegisteredTools,
  listRegisteredTools as listRegisteredToolsRelative,
} from "../src/tool-runtime/internal/registry";

const RETIRED_REGISTRY_READERS = [
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

const NEVER_PUBLIC_REGISTRY_READERS = [
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

test("the package door retires every internal registry reader", () => {
  const keys = new Set(Object.keys(toolRuntimeBarrel));

  for (const name of RETIRED_REGISTRY_READERS) {
    assert.ok(!keys.has(name), `${name} must leave the registry door`);
  }

  for (const name of NEVER_PUBLIC_REGISTRY_READERS) {
    assert.ok(!keys.has(name), `${name} must stay private`);
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
