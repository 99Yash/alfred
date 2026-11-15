import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type {
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  ToolRunContext,
} from "@alfred/contracts";

import { workflowToolCatalog } from "@alfred/assistant/tool-runtime";
import {
  evaluateToolAvailability,
  listRegisteredTools,
} from "../../../src/tool-runtime/internal/registry";
import { registerBuiltinTools } from "../../../src/tool-runtime/builtin-tools";

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
    }
  });

  test("binds the same availability verdict a direct evaluation returns", () => {
    const registered = listRegisteredTools();
    const catalog = workflowToolCatalog();
    const local = registered.find((tool) => tool.integration === "system");
    const gated = registered.find((tool) => tool.availability?.passthrough === true);
    assert.ok(local, "expected at least one system tool");
    assert.ok(gated, "expected at least one availability-gated tool");
    const allowed = new Set<IntegrationSlug>();

    for (const tool of [local, gated]) {
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
