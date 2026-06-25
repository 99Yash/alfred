import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { driveExportFileInput } from "@alfred/contracts";

describe("driveExportFileInput mimeType normalization (ADR-0071)", () => {
  test("normalizes case + whitespace so the forwarded value matches what was validated", () => {
    // Prior bug: the refine lower-cased+trimmed only for the check, then the
    // execute forwarded `input.mimeType` raw — `" Text/Plain "` passed schema
    // validation but reached the Drive API unnormalized and failed there.
    const parsed = driveExportFileInput.parse({ fileId: "abc123", mimeType: " Text/Plain " });
    assert.equal(parsed.mimeType, "text/plain");
  });

  test("a non-text export type is still rejected after normalization", () => {
    const result = driveExportFileInput.safeParse({
      fileId: "abc123",
      mimeType: "application/pdf",
    });
    assert.equal(result.success, false);
  });

  test("an omitted mimeType stays undefined", () => {
    const parsed = driveExportFileInput.parse({ fileId: "abc123" });
    assert.equal(parsed.mimeType, undefined);
  });
});
