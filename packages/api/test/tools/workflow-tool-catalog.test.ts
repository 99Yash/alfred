import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type { IntegrationAvailabilitySnapshot, ToolRunContext } from "@alfred/contracts";

import { workflowToolCatalog } from "@alfred/assistant/tool-runtime";
import { evaluateToolAvailability, listRegisteredTools } from "@alfred/assistant/tool-runtime";
import { registerBuiltinTools } from "../../src/modules/tools/runtime";

before(() => registerBuiltinTools());

const unavailable: IntegrationAvailabilitySnapshot = {
  integrations: new Map(),
  providers: new Map(),
  passthroughEnabled: new Map(),
};

const backgroundContext: ToolRunContext = { caller: "boss", interaction: "background" };

describe("workflow tool catalog", () => {
  test("projects one entry per registered tool with matching facts", () => {
    const registered = listRegisteredTools();
    const catalog = workflowToolCatalog();
    assert.equal(catalog.size, registered.length);
    for (const tool of registered) {
      const facts = catalog.get(tool.name);
      assert.ok(facts, `missing catalog entry for ${tool.name}`);
      assert.equal(facts.name, tool.name);
      assert.equal(facts.integration, tool.integration);
      assert.deepEqual(facts.availability?.credential, tool.availability?.credential);
    }
  });

  test("binds the same availability verdict a direct evaluation returns", () => {
    const registered = listRegisteredTools();
    const catalog = workflowToolCatalog();
    const local = registered.find((tool) => tool.integration === "system");
    const connected = registered.find((tool) => tool.availability?.credential !== undefined);
    assert.ok(local, "expected at least one system tool");
    assert.ok(connected, "expected at least one credential-gated tool");
    const allowed = new Set<string>();
    for (const tool of [local, connected]) {
      const facts = catalog.get(tool.name);
      assert.ok(facts);
      assert.deepEqual(
        facts.evaluateAvailability({
          availability: unavailable,
          allowed,
          context: backgroundContext,
        }),
        evaluateToolAvailability(unavailable, tool, allowed, backgroundContext),
      );
    }
  });
});
