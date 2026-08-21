import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatExtractedMediaText,
  formatExtractedPdfText,
  interpretPdfText,
  type ExtractedPdf,
  type MediaExtractionResult,
} from "../src/index";

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

  test("preserves an empty deterministic text result", () => {
    const result = {
      kind: "text_without_pages",
      pdfType: "text_based",
      pageCount: 0,
      text: "",
    } satisfies ExtractedPdf;

    assert.deepEqual(interpretPdfText(result), { kind: "text", text: "" });
  });

  test("returns null when no deterministic text exists", () => {
    assert.equal(
      formatExtractedPdfText({ kind: "needs_ocr", pdfType: "scanned", pageCount: 1 }),
      null,
    );
  });
});

describe("formatExtractedMediaText", () => {
  test("rebuilds the same markers from pdf page offsets", () => {
    const result = {
      kind: "extracted",
      family: "pdf",
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
      family: "text",
      content: "plain text",
      pages: null,
    } satisfies MediaExtractionResult;

    assert.equal(formatExtractedMediaText(result), "plain text");
  });

  test("returns null for unreadable results", () => {
    const result = { kind: "needs_ocr", family: "pdf" } satisfies MediaExtractionResult;

    assert.equal(formatExtractedMediaText(result), null);
  });
});
