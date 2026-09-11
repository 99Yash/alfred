import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { registerContextSource, searchContext } from "@alfred/assistant/context-search";

/**
 * Behavioral tests for the #423 boundary on `searchContext`: a source's cards
 * are validated against the canonical `EvidenceCard` before they reach the
 * result, so the contract is enforced, not merely typed. A violating card fails
 * its source with an `error` report instead of entering the evidence list.
 *
 * Each test installs and disposes its own source; node's runner isolates test
 * files in separate processes, and the disposer runs in `finally`.
 */

describe("searchContext — card validation at the boundary", () => {
  test("passes a valid card through and reports the source as ok", async () => {
    const dispose = registerContextSource({
      id: "test:valid",
      async search() {
        return {
          evidence: [
            {
              id: "test:valid:1",
              source: { id: "test:valid", kind: "native" },
              mediaKind: "text",
              snippet: "A valid card.",
            },
          ],
        };
      },
    });

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(result.evidence.length, 1);
      assert.equal(result.sources[0]?.status, "ok");
      assert.equal(result.sources[0]?.evidenceCount, 1);
    } finally {
      dispose();
    }
  });

  test("fails a source whose card violates the contract", async () => {
    const dispose = registerContextSource({
      id: "test:invalid",
      async search() {
        // No snippet and no note: structurally typed, contract-invalid.
        return {
          evidence: [
            {
              id: "test:invalid:1",
              source: { id: "test:invalid", kind: "native" },
              mediaKind: "text",
            },
          ],
        };
      },
    });

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(result.evidence.length, 0);
      assert.equal(result.sources[0]?.status, "error");
      assert.equal(result.sources[0]?.evidenceCount, 0);
    } finally {
      dispose();
    }
  });
});
