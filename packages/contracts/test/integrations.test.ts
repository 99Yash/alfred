import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BEARER_PROVIDER_SLUGS,
  CATALOG_SLUGS,
  CREDENTIAL_PROVIDERS,
  CREDENTIAL_SHAPE,
  GENERAL_INVOCATION_COVERAGE,
  GOOGLE_FEATURE_SCOPES,
  INTEGRATION_DISPLAY_NAMES,
  INTEGRATION_SLUGS,
  INTEGRATIONS,
  integrationEntry,
  isCatalogSlug,
  isCredentialProvider,
  isLiveProviderSlug,
  isLoadableIntegrationSlug,
  isPlannedSlug,
  LIVE_PROVIDER_SLUGS,
  liveProviders,
  LOADABLE_INTEGRATION_SLUGS,
  PASSTHROUGH_TOOL_NAMES,
  PASSTHROUGH_TRANSPORT,
  PLANNED_SLUGS,
  SUPPORTED_PASSTHROUGH_SLUGS,
  SUPPORTED_REST_PASSTHROUGH_SLUGS,
  type IntegrationSlug,
} from "@alfred/contracts";

/**
 * The registry's projections replaced hand-typed tables (ADR-0093, registry
 * plan PR 1). These fixtures are those tables, copied verbatim from the last
 * commit that hand-typed them (`main` at 0292be13: `tools.ts`, `credentials.ts`,
 * `passthrough.ts`, and `packages/integrations/src/google/oauth.ts`). The
 * tests below are the proof that PR 1 changed no exported value. When a later
 * PR changes a value on purpose, update the fixture in the same commit.
 */
const BEFORE = {
  LOADABLE_INTEGRATION_SLUGS: [
    "gmail",
    "calendar",
    "drive",
    "docs",
    "sheets",
    "slides",
    "slack",
    "linear",
    "github",
    "notion",
    "railway",
    "vercel",
    "imessage",
  ],
  INTEGRATION_DISPLAY_NAMES: {
    system: "Alfred",
    mcp: "MCP",
    gmail: "Gmail",
    calendar: "Calendar",
    drive: "Drive",
    docs: "Docs",
    sheets: "Sheets",
    slides: "Slides",
    slack: "Slack",
    linear: "Linear",
    github: "GitHub",
    notion: "Notion",
    railway: "Railway",
    vercel: "Vercel",
    imessage: "iMessage",
  },
  CREDENTIAL_SHAPE: {
    gmail: "google_oauth",
    calendar: "google_oauth",
    drive: "google_oauth",
    docs: "google_oauth",
    sheets: "google_oauth",
    slides: "google_oauth",
    slack: "deferred",
    linear: "deferred",
    github: "github_app",
    notion: "bearer",
    railway: "bearer",
    vercel: "bearer",
    imessage: "not_applicable",
  },
  BEARER_PROVIDER_SLUGS: ["notion", "railway", "vercel"],
  GENERAL_INVOCATION_COVERAGE: {
    gmail: "supported",
    calendar: "supported",
    drive: "supported",
    docs: "supported",
    sheets: "supported",
    slides: "supported",
    slack: "deferred",
    linear: "deferred",
    github: "supported",
    notion: "supported",
    railway: "supported",
    vercel: "supported",
    imessage: "not_applicable",
  },
  SUPPORTED_PASSTHROUGH_SLUGS: [
    "gmail",
    "calendar",
    "drive",
    "docs",
    "sheets",
    "slides",
    "github",
    "notion",
    "railway",
    "vercel",
  ],
  PASSTHROUGH_TRANSPORT: {
    gmail: "rest",
    calendar: "rest",
    drive: "rest",
    docs: "rest",
    sheets: "rest",
    slides: "rest",
    github: "rest",
    notion: "rest",
    vercel: "rest",
    railway: "graphql",
  },
  SUPPORTED_REST_PASSTHROUGH_SLUGS: [
    "gmail",
    "calendar",
    "drive",
    "docs",
    "sheets",
    "slides",
    "github",
    "notion",
    "vercel",
  ],
  PASSTHROUGH_TOOL_NAMES: [
    "gmail.request",
    "calendar.request",
    "drive.request",
    "docs.request",
    "sheets.request",
    "slides.request",
    "github.request",
    "notion.request",
    "railway.graphql",
    "vercel.request",
  ],
  GOOGLE_FEATURE_SCOPES: {
    briefing: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
    triage: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    reply_draft: ["https://www.googleapis.com/auth/gmail.send"],
    calendar: ["https://www.googleapis.com/auth/calendar.events"],
    drive: ["https://www.googleapis.com/auth/drive"],
    docs: ["https://www.googleapis.com/auth/documents"],
    sheets: ["https://www.googleapis.com/auth/spreadsheets"],
    slides: ["https://www.googleapis.com/auth/presentations"],
  },
} as const;

describe("integration registry — no value drift from the hand-typed tables (plan section 8 item 1)", () => {
  test("the slug tuples keep their members and their order", () => {
    assert.deepEqual(
      [...INTEGRATION_SLUGS],
      ["system", "mcp", ...BEFORE.LOADABLE_INTEGRATION_SLUGS],
    );
    assert.deepEqual([...LOADABLE_INTEGRATION_SLUGS], BEFORE.LOADABLE_INTEGRATION_SLUGS);
  });

  test("INTEGRATION_DISPLAY_NAMES", () => {
    assert.deepEqual(INTEGRATION_DISPLAY_NAMES, BEFORE.INTEGRATION_DISPLAY_NAMES);
  });

  test("CREDENTIAL_SHAPE and the bearer list", () => {
    assert.deepEqual(CREDENTIAL_SHAPE, BEFORE.CREDENTIAL_SHAPE);
    assert.deepEqual([...BEARER_PROVIDER_SLUGS], BEFORE.BEARER_PROVIDER_SLUGS);
  });

  test("GENERAL_INVOCATION_COVERAGE and the supported lists", () => {
    assert.deepEqual(GENERAL_INVOCATION_COVERAGE, BEFORE.GENERAL_INVOCATION_COVERAGE);
    assert.deepEqual([...SUPPORTED_PASSTHROUGH_SLUGS], BEFORE.SUPPORTED_PASSTHROUGH_SLUGS);
    assert.deepEqual(
      [...SUPPORTED_REST_PASSTHROUGH_SLUGS],
      BEFORE.SUPPORTED_REST_PASSTHROUGH_SLUGS,
    );
  });

  test("PASSTHROUGH_TRANSPORT and the registered tool names", () => {
    assert.deepEqual(PASSTHROUGH_TRANSPORT, BEFORE.PASSTHROUGH_TRANSPORT);
    assert.deepEqual([...PASSTHROUGH_TOOL_NAMES], BEFORE.PASSTHROUGH_TOOL_NAMES);
  });

  test("GOOGLE_FEATURE_SCOPES moved from @alfred/integrations unchanged", () => {
    assert.deepEqual(GOOGLE_FEATURE_SCOPES, BEFORE.GOOGLE_FEATURE_SCOPES);
  });
});

describe("integration registry — the derived lists agree with the record", () => {
  test("live providers are the supported passthrough slugs, in registry order", () => {
    // Every live provider has a passthrough today, so the two lists coincide.
    // The equality is a fact about the current record, not a rule: a live
    // provider with `passthrough: null` would split them.
    assert.deepEqual([...LIVE_PROVIDER_SLUGS], BEFORE.SUPPORTED_PASSTHROUGH_SLUGS);
    assert.deepEqual(
      liveProviders().map((entry) => entry.slug),
      BEFORE.SUPPORTED_PASSTHROUGH_SLUGS,
    );
  });

  test("liveProviders() carries each entry's own fields under its slug", () => {
    for (const entry of liveProviders()) {
      const { slug, ...fields } = entry;
      assert.deepEqual(fields, INTEGRATIONS[slug], slug);
    }
  });

  test("the credential providers are distinct and in first-appearance order", () => {
    assert.deepEqual(
      [...CREDENTIAL_PROVIDERS],
      ["google", "github", "notion", "railway", "vercel"],
    );
    assert.equal(isCredentialProvider("google"), true);
    assert.equal(isCredentialProvider("gmail"), false);
    assert.equal(isCredentialProvider("slack"), false);
  });

  test("catalog and planned lists partition the providers", () => {
    assert.deepEqual(
      [...CATALOG_SLUGS],
      [...LIVE_PROVIDER_SLUGS, ...PLANNED_SLUGS].sort(bySlugOrder),
    );
    assert.deepEqual([...PLANNED_SLUGS], ["slack", "linear"]);
    assert.equal(isPlannedSlug("slack"), true);
    assert.equal(isLiveProviderSlug("slack"), false);
    assert.equal(isCatalogSlug("imessage"), false);
    assert.equal(isLoadableIntegrationSlug("imessage"), true);
    assert.equal(isLoadableIntegrationSlug("mcp"), false);
  });

  test("integrationEntry is the typed index into the record", () => {
    assert.equal(integrationEntry("github").credential.shape, "github_app");
    assert.equal(integrationEntry("railway").credential.connect, "token_paste");
    assert.equal(integrationEntry("slack").status, "planned");
    assert.equal(integrationEntry("imessage").kind, "channel");
  });
});

function bySlugOrder(a: IntegrationSlug, b: IntegrationSlug): number {
  return INTEGRATION_SLUGS.indexOf(a) - INTEGRATION_SLUGS.indexOf(b);
}
