import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatExtractedMediaText,
  mediaFailureMessage,
  type MediaExtractionResult,
} from "../src/index";

describe("formatExtractedMediaText", () => {
  test("rebuilds the same markers from pdf page offsets", () => {
    const result = {
      kind: "extracted",
      format: "pdf",
      content: "First page\n\nSecond page",
      pages: [
        { page: 1, start: 0, end: 10 },
        { page: 2, start: 12, end: 23 },
      ],
    } satisfies MediaExtractionResult;

    assert.equal(formatExtractedMediaText(result), "[page 1]\nFirst page\n\n[page 2]\nSecond page");
  });

  test("uses plain content when no offsets are proven", () => {
    const result = {
      kind: "extracted",
      format: "text",
      content: "plain text",
      pages: null,
    } satisfies MediaExtractionResult;

    assert.equal(formatExtractedMediaText(result), "plain text");
  });

  test("returns null for unreadable results", () => {
    const result = { kind: "needs_ocr", format: "pdf" } satisfies MediaExtractionResult;

    assert.equal(formatExtractedMediaText(result), null);
  });
});

describe("mediaFailureMessage", () => {
  test("maps each failure kind to its user-facing message", () => {
    const cases: [
      Exclude<MediaExtractionResult, { kind: "extracted" }>,
      string,
    ][] = [
      [
        { kind: "needs_ocr", format: "pdf" },
        "This PDF is image-based and needs OCR to extract text, which is not yet supported.",
      ],
      [
        { kind: "encrypted", format: "pdf" },
        "This PDF is encrypted and its text cannot be extracted.",
      ],
      [
        { kind: "invalid", format: "pdf", reason: "corrupt xref" },
        "This PDF is invalid: corrupt xref",
      ],
      [
        {
          kind: "limit_exceeded",
          format: "pdf",
          limit: "output_characters",
          actual: 200,
          maximum: 100,
          message: "output character limit exceeded: 200 > 100",
        },
        "PDF extraction exceeded the limit: output character limit exceeded: 200 > 100",
      ],
    ];
    for (const [result, expected] of cases) {
      assert.equal(mediaFailureMessage(result), expected);
    }
  });
});
