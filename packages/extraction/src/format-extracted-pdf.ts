import type { ExtractedPdf } from "./extract-pdf";
import type { MediaExtractionResult } from "./media-extraction";

interface MarkedPage {
  readonly pageNumber: number;
  readonly markdown: string;
}

function joinMarkedPages(pages: readonly MarkedPage[]): string {
  return pages.map((page) => `[page ${page.pageNumber}]\n${page.markdown}`).join("\n\n");
}

/**
 * Format deterministic PDF output for a text consumer. Page markers are added
 * only when the extractor proved the page boundary.
 */
export function formatExtractedPdfText(result: ExtractedPdf): string | null {
  if (result.kind === "extracted" && result.pages.length > 0) {
    return joinMarkedPages(result.pages);
  }
  if (result.kind === "extracted" || result.kind === "text_without_pages") {
    return result.text;
  }
  return null;
}

/**
 * Format a normalized media extraction for a text consumer — the same
 * `[page N]` contract as `formatExtractedPdfText`, rebuilt from the page
 * offsets that travel with `MediaExtractionResult`. Corpus consumers slice
 * `content` by those offsets and must not use this marked-up rendering.
 */
export function formatExtractedMediaText(result: MediaExtractionResult): string | null {
  if (result.kind !== "extracted") return null;
  if (result.family === "pdf" && result.pages && result.pages.length > 0) {
    const { content, pages } = result;
    return joinMarkedPages(
      pages.map((entry) => ({
        pageNumber: entry.page,
        markdown: content.slice(entry.start, entry.end),
      })),
    );
  }
  return result.content;
}

export type PdfTextInterpretation =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "unreadable";
      readonly reason: "needs_ocr" | "encrypted" | "invalid" | "limit_exceeded";
      readonly message: string;
    };

/**
 * Turn an extraction result into the one text-or-reason contract used by every
 * realtime door. An empty string is valid deterministic text and stays distinct
 * from an unreadable PDF.
 */
export function interpretPdfText(result: ExtractedPdf): PdfTextInterpretation {
  switch (result.kind) {
    case "extracted":
      return { kind: "text", text: formatExtractedPdfText(result) ?? result.text };
    case "text_without_pages":
      return { kind: "text", text: result.text };
    case "needs_ocr":
      return {
        kind: "unreadable",
        reason: "needs_ocr",
        message:
          "This PDF is image-based and needs OCR to extract text, which is not yet supported.",
      };
    case "encrypted":
      return {
        kind: "unreadable",
        reason: "encrypted",
        message: "This PDF is encrypted and its text cannot be extracted.",
      };
    case "invalid":
      return {
        kind: "unreadable",
        reason: "invalid",
        message: `This PDF is invalid: ${result.reason}`,
      };
    case "limit_exceeded":
      return {
        kind: "unreadable",
        reason: "limit_exceeded",
        message: `PDF extraction exceeded the limit: ${result.message}`,
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
