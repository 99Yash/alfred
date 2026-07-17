import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { driveExportFileInput, driveSearchInput } from "@alfred/contracts";

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

describe("driveSearchInput bare-term guard (the one real Drive-DSL fumble)", () => {
  test("rewrites a bare search term into a name/fullText contains clause", () => {
    // `q=resume` is not valid Drive query syntax — Drive 400s on it. Rewrite it
    // into a clause that executes instead of erroring.
    const parsed = driveSearchInput.parse({ q: "resume" });
    assert.equal(parsed.q, "name contains 'resume' or fullText contains 'resume'");
  });

  test("drops a lone `*` so the call lists recent files instead of 400ing", () => {
    const parsed = driveSearchInput.parse({ q: "*" });
    assert.equal(parsed.q, undefined);
  });

  test("leaves a well-formed Drive query clause untouched", () => {
    for (const q of [
      "name contains 'budget'",
      "mimeType = 'application/vnd.google-apps.document'",
      "modifiedTime > '2026-07-07T00:00:00'",
    ]) {
      assert.equal(driveSearchInput.parse({ q }).q, q);
    }
  });

  test("a term containing a quote is NOT treated as bare (left for Drive to validate)", () => {
    // Only word chars / `.` / `-` count as a bare term; a quote means it's not
    // a lone token, so we don't rewrite it.
    const parsed = driveSearchInput.parse({ q: "o'brien" });
    assert.equal(parsed.q, "o'brien");
  });

  test("still accepts the `query` alias and folds it to q before the guard", () => {
    const parsed = driveSearchInput.parse({ query: "resume" });
    assert.equal(parsed.q, "name contains 'resume' or fullText contains 'resume'");
  });
});
