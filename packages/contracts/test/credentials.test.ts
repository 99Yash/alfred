import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BEARER_PROVIDER_SLUGS,
  CREDENTIAL_SHAPE,
  LOADABLE_INTEGRATION_SLUGS,
  credentialShapeForSlug,
  isBearerProvider,
} from "@alfred/contracts";

describe("credential-shape registry", () => {
  test("every loadable integration slug declares a credential shape (no silent drift)", () => {
    assert.deepEqual(Object.keys(CREDENTIAL_SHAPE).sort(), [...LOADABLE_INTEGRATION_SLUGS].sort());
  });

  test("the bearer list matches the map exactly", () => {
    const bearer = LOADABLE_INTEGRATION_SLUGS.filter(
      (slug) => CREDENTIAL_SHAPE[slug] === "bearer",
    ).sort();
    assert.deepEqual([...BEARER_PROVIDER_SLUGS].sort(), bearer);
  });

  test("v1 classifications are pinned", () => {
    for (const slug of ["gmail", "calendar", "drive", "docs", "sheets", "slides"] as const) {
      assert.equal(CREDENTIAL_SHAPE[slug], "google_oauth", slug);
    }
    assert.equal(CREDENTIAL_SHAPE.github, "github_app");
    for (const slug of ["notion", "railway", "vercel"] as const) {
      assert.equal(CREDENTIAL_SHAPE[slug], "bearer", slug);
    }
    assert.equal(CREDENTIAL_SHAPE.slack, "deferred");
    assert.equal(CREDENTIAL_SHAPE.linear, "deferred");
    assert.equal(CREDENTIAL_SHAPE.imessage, "not_applicable");
  });

  test("isBearerProvider agrees with the registry", () => {
    assert.equal(isBearerProvider("notion"), true);
    assert.equal(isBearerProvider("gmail"), false);
    assert.equal(isBearerProvider("github"), false);
    assert.equal(isBearerProvider("not_a_slug"), false);
  });

  test("credentialShapeForSlug resolves dynamic strings and rejects non-slugs", () => {
    assert.equal(credentialShapeForSlug("vercel"), "bearer");
    assert.equal(credentialShapeForSlug("gmail"), "google_oauth");
    // The web catalog's own ids (`google_gmail`) are NOT slugs — callers must
    // de-prefix first, and an unmapped string must read as "nothing to probe"
    // rather than falling through to some other provider's probe.
    assert.equal(credentialShapeForSlug("google_gmail"), undefined);
    assert.equal(credentialShapeForSlug("system"), undefined);
    assert.equal(credentialShapeForSlug(""), undefined);
  });
});
