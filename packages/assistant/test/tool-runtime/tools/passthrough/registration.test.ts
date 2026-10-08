import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  INTEGRATIONS,
  isSupportedPassthroughSlug,
  PASSTHROUGH_TOOL_ACTION,
  SUPPORTED_PASSTHROUGH_SLUGS,
  type SupportedPassthroughSlug,
} from "@alfred/contracts";
import { clearToolRegistryForTests, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { registerBuiltinTools } from "../../../../src/tool-runtime/builtin-tools";
import { listToolsForIntegration } from "../../../../src/tool-runtime/internal/registry";

/** After boot, every slug with a `passthrough` entry registers exactly one passthrough tool. */

function passthroughToolsFor(slug: SupportedPassthroughSlug): RegisteredTool[] {
  return listToolsForIntegration(slug).filter((tool) => tool.availability?.passthrough === true);
}

describe("passthrough tool registration", () => {
  test("every supported slug registers exactly one passthrough tool", () => {
    clearToolRegistryForTests();
    registerBuiltinTools();

    try {
      for (const slug of SUPPORTED_PASSTHROUGH_SLUGS) {
        const tools = passthroughToolsFor(slug);
        assert.equal(tools.length, 1, `${slug} must register exactly one passthrough tool`);
        const [tool] = tools;
        assert.equal(tool?.availability?.passthrough, true);
        assert.equal(tool?.riskTier, "no_risk", `${slug} passthrough is a read (no_risk)`);
        assert.equal(
          tool?.action,
          PASSTHROUGH_TOOL_ACTION[INTEGRATIONS[slug].passthrough.transport],
          `${slug} passthrough action matches its transport`,
        );
      }
    } finally {
      clearToolRegistryForTests();
    }
  });

  test("planned providers and channels expose no passthrough tool", () => {
    clearToolRegistryForTests();
    registerBuiltinTools();

    try {
      for (const slug of ["slack", "linear", "imessage"] as const) {
        assert.equal(isSupportedPassthroughSlug(slug), false);
        // These slugs have no live tool module at all; listing returns nothing.
        assert.equal(
          listToolsForIntegration(slug).filter((t) => t.availability?.passthrough === true).length,
          0,
        );
      }
    } finally {
      clearToolRegistryForTests();
    }
  });
});
