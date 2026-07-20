import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GENERAL_INVOCATION_COVERAGE,
  PASSTHROUGH_TOOL_ACTION,
  PASSTHROUGH_TRANSPORT,
  SUPPORTED_PASSTHROUGH_SLUGS,
  type SupportedIntegrationSlug,
} from "@alfred/contracts";
import {
  clearToolRegistryForTests,
  listToolsForIntegration,
  registerBuiltinTools,
  type RegisteredTool,
} from "../../../src/modules/tools";

/**
 * Registration invariant (PRD "Testing Decisions" — every supported slug has
 * exactly one handler/tool). This asserts the *runtime* surface after boot,
 * complementing coverage.test.ts's compile-time/contract assertions.
 *
 * The general invocation tier is now fully wired: Railway (graphql) plus the
 * REST family (github/notion/vercel + the Google products
 * gmail/calendar/drive/docs/sheets/slides). Every `supported` slug in the
 * coverage map registers exactly one passthrough tool — this test is the
 * forcing function so a supported slug can never ship without its tool.
 */

function passthroughToolsFor(slug: SupportedIntegrationSlug): RegisteredTool[] {
  return listToolsForIntegration(slug).filter((tool) => tool.availability?.passthrough === true);
}

describe("passthrough tool registration", () => {
  test("every supported slug registers exactly one passthrough tool", () => {
    clearToolRegistryForTests();
    registerBuiltinTools();
    try {
      for (const slug of SUPPORTED_PASSTHROUGH_SLUGS) {
        assert.equal(GENERAL_INVOCATION_COVERAGE[slug], "supported", `${slug} is supported`);
        const tools = passthroughToolsFor(slug);
        assert.equal(tools.length, 1, `${slug} must register exactly one passthrough tool`);
        const [tool] = tools;
        assert.equal(tool?.availability?.passthrough, true);
        assert.equal(tool?.riskTier, "no_risk", `${slug} passthrough is a read (no_risk)`);
        assert.equal(
          tool?.action,
          PASSTHROUGH_TOOL_ACTION[PASSTHROUGH_TRANSPORT[slug]],
          `${slug} passthrough action matches its transport`,
        );
      }
    } finally {
      clearToolRegistryForTests();
    }
  });

  test("deferred / not-applicable slugs expose no passthrough tool", () => {
    clearToolRegistryForTests();
    registerBuiltinTools();
    try {
      for (const slug of ["slack", "linear", "imessage"] as const) {
        assert.notEqual(GENERAL_INVOCATION_COVERAGE[slug], "supported");
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
