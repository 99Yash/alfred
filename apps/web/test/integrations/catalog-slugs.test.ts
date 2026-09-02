import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { INTEGRATION_SLUGS, LOADABLE_INTEGRATION_SLUGS } from "@alfred/contracts";

import {
  brandForIntegration,
  getIntegrationProvider,
  integrationSlugForProvider,
} from "../../src/lib/integrations/integrations";

/**
 * The web catalog is keyed by provider id while the tool runtime is keyed by
 * slug. One table joins them; these tests pin the two directions so a slug
 * with a page can never lose its brand or its policy control again (Notion,
 * Railway, and Vercel once did).
 */
describe("integration slug <-> catalog id", () => {
  const PAGELESS = new Set(["system", "mcp", "imessage"]);

  test("every slug with a catalog page resolves to a provider with a brand", () => {
    for (const slug of INTEGRATION_SLUGS) {
      const provider = getIntegrationProvider(slug);
      if (PAGELESS.has(slug)) {
        assert.equal(provider, undefined, `${slug} should have no catalog page`);
        assert.equal(brandForIntegration(slug), undefined);
        continue;
      }
      assert.ok(provider, `${slug} has no catalog provider`);
      assert.equal(brandForIntegration(slug), provider.brand);
    }
  });

  test("the catalog id round-trips back to its slug", () => {
    for (const slug of LOADABLE_INTEGRATION_SLUGS) {
      const provider = getIntegrationProvider(slug);
      if (!provider) continue;
      assert.equal(integrationSlugForProvider(provider.id), slug);
    }
  });

  test("the bearer providers keep their brand and slug", () => {
    for (const slug of ["notion", "railway", "vercel"] as const) {
      assert.equal(brandForIntegration(slug), slug);
      assert.equal(integrationSlugForProvider(slug), slug);
    }
  });

  test("an unknown id passes through unchanged", () => {
    assert.equal(integrationSlugForProvider("clickup"), "clickup");
    assert.equal(getIntegrationProvider("clickup"), undefined);
  });
});
