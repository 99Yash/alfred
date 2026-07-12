import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mediaEnrichmentModelRoutes } from "../src/provider";

describe("media enrichment capability routing", () => {
  test("routes images through Flash, Flash-Lite, then Sonnet", () => {
    assert.deepEqual(mediaEnrichmentModelRoutes("image", 1_000), [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "claude-sonnet-4-6",
    ]);
  });

  test("skips Flash for PDF input it does not advertise", () => {
    assert.deepEqual(mediaEnrichmentModelRoutes("pdf", 1_000), [
      "gemini-2.5-flash-lite",
      "claude-sonnet-4-6",
    ]);
  });

  test("rejects payloads beyond every compatible inline limit", () => {
    assert.deepEqual(mediaEnrichmentModelRoutes("video", 60 * 1024 * 1024), []);
  });
});
