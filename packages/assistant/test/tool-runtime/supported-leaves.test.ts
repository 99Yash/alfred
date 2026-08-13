import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { clearToolRegistryForTests } from "@alfred/assistant/tool-runtime";
import { listRegisteredTools } from "../../src/tool-runtime/internal/registry";

afterEach(clearToolRegistryForTests);

test("the dispatch leaf exposes only production operations and registers no tools", async () => {
  clearToolRegistryForTests();
  const dispatch = await import("@alfred/assistant/tool-runtime/dispatch");

  assert.deepEqual(Object.keys(dispatch).sort(), [
    "dispatchToolCall",
    "registerDispatchToolCallRoundAdapter",
  ]);
  assert.deepEqual(listRegisteredTools(), []);
});

test("the built-in leaf registers only when its operation is called", async () => {
  clearToolRegistryForTests();
  const builtins = await import("@alfred/assistant/tool-runtime/builtin-tools");

  assert.deepEqual(Object.keys(builtins), ["registerBuiltinTools"]);
  assert.deepEqual(listRegisteredTools(), []);

  builtins.registerBuiltinTools();
  assert.ok(listRegisteredTools().length > 0);
});
