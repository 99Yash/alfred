import type { ExtractedPdf } from "./extract-pdf";

/**
 * Format deterministic PDF output for a text consumer. Page markers are added
 * only when the extractor proved the page boundary.
 */
export function formatExtractedPdfText(result: ExtractedPdf): string | null {
  if (result.kind === "extracted" && result.pages.length > 0) {
    return result.pages.map((page) => `[page ${page.pageNumber}]\n${page.markdown}`).join("\n\n");
  }
  if (result.kind === "extracted" || result.kind === "text_without_pages") {
    return result.text;
  }
  return null;
}
