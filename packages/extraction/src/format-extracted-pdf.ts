import type { MediaExtractionResult } from "./media-extraction";

interface MarkedPage {
  readonly pageNumber: number;
  readonly markdown: string;
}

function joinMarkedPages(pages: readonly MarkedPage[]): string {
  return pages.map((page) => `[page ${page.pageNumber}]\n${page.markdown}`).join("\n\n");
}

/**
 * Format a normalized media extraction for a text consumer — the
 * `[page N]` contract, rebuilt from the page offsets that travel with
 * `MediaExtractionResult`. Corpus consumers slice `content` by those offsets
 * and must not use this marked-up rendering.
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

/**
 * The one user-facing message per failed `MediaExtractionResult` kind.
 * Callers handle `null` (unsupported MIME) and `extracted` before this, so
 * those cases never reach it. One home: a wording change lands here, not in
 * a ternary chain per consumer.
 */
export function mediaFailureMessage(result: MediaExtractionResult): string {
  switch (result.kind) {
    case "needs_ocr":
      return "This PDF is image-based and needs OCR to extract text, which is not yet supported.";
    case "encrypted":
      return "This PDF is encrypted and its text cannot be extracted.";
    case "invalid":
      return `This PDF is invalid: ${result.reason}`;
    case "limit_exceeded":
      return `PDF extraction exceeded the limit: ${result.message}`;
    case "extracted":
      return "";
  }
}
