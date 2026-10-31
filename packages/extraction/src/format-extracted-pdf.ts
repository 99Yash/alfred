import { assertNever } from "@alfred/contracts";
import type { ContentFormat } from "@alfred/contracts";
import type { MediaExtractionResult } from "./media-extraction";

interface MarkedPage {
  readonly pageNumber: number;
  readonly markdown: string;
}

function joinMarkedPages(pages: readonly MarkedPage[]): string {
  return pages.map((page) => `[page ${page.pageNumber}]\n${page.markdown}`).join("\n\n");
}

/** Render extracted text with `[page N]` markers. The corpus slices raw `content` instead. */
export function formatExtractedMediaText(
  result: Extract<MediaExtractionResult, { kind: "extracted" }>,
): string;
export function formatExtractedMediaText(result: MediaExtractionResult): string | null;
export function formatExtractedMediaText(result: MediaExtractionResult): string | null {
  if (result.kind !== "extracted") return null;

  if (result.format === "pdf" && result.pages && result.pages.length > 0) {
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

const FORMAT_NOUNS = {
  pdf: "PDF",
  document: "document",
  spreadsheet: "spreadsheet",
  text: "text file",
} as const satisfies Readonly<Record<ContentFormat, string>>;

/** The user-facing message for each failed result kind. The type excludes `extracted`. */
export function mediaFailureMessage(
  result: Exclude<MediaExtractionResult, { kind: "extracted" }>,
): string {
  const noun = FORMAT_NOUNS[result.format];

  switch (result.kind) {
    case "needs_ocr":
      return `This ${noun} is image-based and needs OCR to extract text, which is not yet supported.`;
    case "encrypted":
      return `This ${noun} is encrypted and its text cannot be extracted.`;
    case "invalid":
      return `This ${noun} is invalid: ${result.reason}`;
    case "limit_exceeded":
      return `${capitalizeFirst(noun)} extraction exceeded the limit: ${result.message}`;
    default:
      return assertNever(result, "media failure kind");
  }
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
