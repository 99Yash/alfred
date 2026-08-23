import type { PageMarkdownResult, PdfType } from "@firecrawl/pdf-inspector";

import {
  PdfExtractionError,
  type ExtractedPdf,
  type ExtractedPdfPage,
  type InvalidPdfCause,
  type PdfDocumentType,
} from "./extract-pdf";
import type { PdfExtractionLimits } from "./constants";
import {
  createPdfExtractionLimitResult,
  pdfExtractionContentCharacterCount,
  pdfExtractionPageCharacterCount,
  truncatePagesToFit,
  truncateTextToFit,
} from "./extract-pdf-protocol";

interface PdfInspector {
  readonly classifyPdfAsync: (buffer: Buffer) => Promise<{ readonly pdfType: `${PdfType}` }>;
  readonly extractPagesMarkdownAsync: (
    buffer: Buffer,
  ) => Promise<{ readonly pages: readonly PageMarkdownResult[] }>;
  readonly extractText: (buffer: Buffer) => string;
}
type LoadPdfInspector = () => Promise<PdfInspector>;

const PDF_DOCUMENT_TYPES: Readonly<Record<`${PdfType}`, PdfDocumentType>> = {
  TextBased: "text_based",
  Scanned: "scanned",
  ImageBased: "image_based",
  Mixed: "mixed",
};
const VENDOR_FAILURE_CODE = "GenericFailure";
const ENCRYPTED_MESSAGE = "PDF is encrypted";
const NOT_A_PDF_PREFIX = "Not a PDF: ";
const PDF_STRUCTURE_MARKERS = ["%PDF-", "startxref", "%%EOF"] as const;
const RUST_FUNCTION_PREFIX = /^[a-z][a-z0-9_]*: /;

let inspectorPromise: Promise<PdfInspector> | undefined;

function loadInspector(): Promise<PdfInspector> {
  inspectorPromise ??= import("@firecrawl/pdf-inspector");
  return inspectorPromise;
}

function toPdfDocumentType(pdfType: `${PdfType}`): PdfDocumentType {
  return PDF_DOCUMENT_TYPES[pdfType];
}

function isVendorFailure(error: unknown): error is Error {
  return error instanceof Error && "code" in error && error.code === VENDOR_FAILURE_CODE;
}

function hasPdfMarkers(buffer: Buffer): boolean {
  return PDF_STRUCTURE_MARKERS.some((marker) => buffer.includes(marker));
}

function toInvalidPdfCause(reason: string, buffer: Buffer): InvalidPdfCause {
  if (hasPdfMarkers(buffer)) return "damaged";
  return reason.startsWith(NOT_A_PDF_PREFIX) ? "not_a_pdf" : "damaged";
}

function toExtractedPdfFailure(error: unknown, buffer: Buffer): ExtractedPdf | undefined {
  if (!isVendorFailure(error)) return undefined;
  const { message } = error;
  if (message.includes(ENCRYPTED_MESSAGE)) return { kind: "encrypted" };
  const reason = message.replace(RUST_FUNCTION_PREFIX, "");
  return { kind: "invalid", cause: toInvalidPdfCause(reason, buffer), reason };
}

function hasText(text: string): boolean {
  return text.trim().length > 0;
}

function pageHasText(page: ExtractedPdfPage): boolean {
  return hasText(page.markdown);
}

function readDocumentText(inspector: PdfInspector, buffer: Buffer): string | undefined {
  let text: string;
  try {
    text = inspector.extractText(buffer);
  } catch (error) {
    if (isVendorFailure(error)) return undefined;
    throw error;
  }
  return hasText(text) ? text : undefined;
}

function toExtractedPdfPage(page: PageMarkdownResult): ExtractedPdfPage {
  return {
    pageNumber: page.page + 1,
    markdown: page.markdown,
    needsOcr: page.needsOcr,
    ...(page.ocrReason === undefined ? {} : { ocrReason: page.ocrReason }),
  };
}

/**
 * Run all vendor work inside the extraction child. Page output is checked before
 * the synchronous document read, then the exact public content count is checked
 * again before a successful reply can cross the process boundary.
 */
export async function extractPdfCore(
  bytes: Uint8Array,
  limits: Pick<PdfExtractionLimits, "maxCharacters"> &
    Partial<Pick<PdfExtractionLimits, "truncateOnOutputExceed">>,
  load: LoadPdfInspector = loadInspector,
): Promise<ExtractedPdf> {
  const { maxCharacters } = limits;
  // Keep native-load rejection distinct from PdfExtractionError. The child
  // protocol preserves this distinction for the parent.
  const inspector = await load();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  try {
    const classification = await inspector.classifyPdfAsync(buffer);
    const pdfType = toPdfDocumentType(classification.pdfType);
    const extraction = await inspector.extractPagesMarkdownAsync(buffer);
    const pages = extraction.pages.map(toExtractedPdfPage);
    const pageCount = pages.length;
    let mutablePages = pages;
    const pageCharacters = pdfExtractionPageCharacterCount(mutablePages);

    if (pageCharacters > maxCharacters) {
      if (limits.truncateOnOutputExceed) {
        mutablePages = truncatePagesToFit(mutablePages, maxCharacters);
      } else {
        return createPdfExtractionLimitResult("output_characters", pageCharacters, maxCharacters);
      }
    }

    const text = readDocumentText(inspector, buffer);

    if (mutablePages.some(pageHasText)) {
      let documentText = text ?? "";
      let result: ExtractedPdf = {
        kind: "extracted",
        pdfType,
        pageCount,
        pages: mutablePages,
        pagesNeedingOcr: mutablePages
          .filter((page) => page.needsOcr)
          .map((page) => page.pageNumber),
        text: documentText,
      };
      const totalCharacters = pdfExtractionContentCharacterCount(result);
      if (totalCharacters > maxCharacters) {
        if (limits.truncateOnOutputExceed) {
          // Truncate text to fit remaining budget after pages
          const pageChars = pdfExtractionPageCharacterCount(mutablePages);
          const remaining = Math.max(0, maxCharacters - pageChars);
          documentText = truncateTextToFit(documentText, remaining);
          result = {
            kind: "extracted",
            pdfType,
            pageCount,
            pages: mutablePages,
            pagesNeedingOcr: mutablePages
              .filter((page) => page.needsOcr)
              .map((page) => page.pageNumber),
            text: documentText,
          };
        } else {
          return createPdfExtractionLimitResult(
            "output_characters",
            totalCharacters,
            maxCharacters,
          );
        }
      }
      return result;
    }

    if (text !== undefined) {
      let truncatedText = text;
      const result: ExtractedPdf = {
        kind: "text_without_pages",
        pdfType,
        pageCount,
        text: truncatedText,
      };
      const totalCharacters = pdfExtractionContentCharacterCount(result);
      if (totalCharacters > maxCharacters) {
        if (limits.truncateOnOutputExceed) {
          truncatedText = truncateTextToFit(text, maxCharacters);
          return { kind: "text_without_pages", pdfType, pageCount, text: truncatedText };
        }
        return createPdfExtractionLimitResult("output_characters", totalCharacters, maxCharacters);
      }
      return result;
    }

    return { kind: "needs_ocr", pdfType, pageCount };
  } catch (error) {
    const failure = toExtractedPdfFailure(error, buffer);
    if (failure === undefined) throw new PdfExtractionError(error);
    return failure;
  }
}
