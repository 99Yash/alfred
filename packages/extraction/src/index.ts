// Bytes in, text and 1-indexed pages out. The only caller of `@firecrawl/pdf-inspector`,
// which runs in a child process that can be killed.
// Export constants only from here, not through `extract-pdf` or `media-extraction`.
export { createPdfExtractor, PdfExtractionError } from "./extract-pdf";

export type {
  ExtractPdf,
  ExtractedPdf,
  ExtractedPdfPage,
  InvalidPdfCause,
  PdfDocumentType,
  PdfExtractionLimitKind,
} from "./extract-pdf";

export {
  DOOR_LIMITS,
  OFFICE_LIMITS_BY_DOOR,
  REALTIME_PDF_EXTRACTION_LIMITS,
  TEXT_LIMITS_BY_DOOR,
} from "./constants";

export type { ExtractionDoor, ExtractionLimits, PdfExtractionLimits } from "./constants";

export { formatExtractedMediaText, mediaFailureMessage } from "./format-extracted-pdf";

export { FORMAT_REGISTRY } from "./media-extraction";

export type { MediaExtractionResult, MediaExtractor } from "./media-extraction";

export { extraction } from "./extraction.facade";

export type { Extraction, ExtractionOptions } from "./extraction.facade";
