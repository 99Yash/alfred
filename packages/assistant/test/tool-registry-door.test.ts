/**
 * The tool-registry door on `@alfred/assistant/tool-runtime`.
 *
 * Two things are under test, and the second is the whole reason the file exists:
 *
 * 1. The barrel publishes the registration + lookup door, imported through the
 *    PACKAGE specifier. That spelling is what makes this a red-run detector for
 *    the `exports` seam — a manifest key that stops resolving fails here.
 * 2. ONE map. Writers live in `@alfred/api` (21 tool-definition files) and
 *    readers live in `@alfred/api`, `@alfred/http` and `apps/server`, so a
 *    per-root module fork would silently split the catalog. Registering through
 *    the package specifier and reading back through the relative
 *    `../src/tool-runtime/internal/registry` spelling proves the two specifiers
 *    resolve to one module instance. This detects a fork; it does not prevent
 *    one.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
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

test("the package specifier and the relative path resolve to the same registry map", () => {
  clearToolRegistryForTests();
  const tool = probeTool("write_scratch");

  registerTool(tool);

  assert.equal(
    getToolRelative(tool.name),
    tool,
    "a second module instance would return undefined here",
  );
  assert.deepEqual(
    listRegisteredToolsRelative().map((entry) => entry.name),
    [tool.name],
  );
});
