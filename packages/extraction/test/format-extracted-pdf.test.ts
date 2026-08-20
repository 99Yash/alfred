import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatExtractedPdfText, type ExtractedPdf } from "../src/index";

describe("formatExtractedPdfText", () => {
  test("adds one proven marker to each extracted page", () => {
    const result = {
      kind: "extracted",
      pdfType: "text_based",
      pageCount: 2,
      pages: [
        { pageNumber: 1, markdown: "First page", needsOcr: false },
        { pageNumber: 2, markdown: "Second page", needsOcr: false },
      ],
      pagesNeedingOcr: [],
      text: "First page\nSecond page",
    } satisfies ExtractedPdf;

    assert.equal(formatExtractedPdfText(result), "[page 1]\nFirst page\n\n[page 2]\nSecond page");
  });

  test("uses unpaged text without inventing a page marker", () => {
    const result = {
      kind: "text_without_pages",
      pdfType: "text_based",
      pageCount: 2,
      text: "Readable text without proven boundaries",
    } satisfies ExtractedPdf;

    assert.equal(formatExtractedPdfText(result), result.text);
  });

  test("returns null when no deterministic text exists", () => {
    assert.equal(
      formatExtractedPdfText({ kind: "needs_ocr", pdfType: "scanned", pageCount: 1 }),
      null,
    );
  });
});
