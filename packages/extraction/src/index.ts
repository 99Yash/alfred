// @alfred/extraction — the one deterministic reader of a PDF's bytes. Bytes in,
// pages out, with every page number 1-indexed. The wrapper is the only caller of
// `@firecrawl/pdf-inspector`; the configured reader runs it in a killable child.

// Canonical constant owner is `./constants` — do not re-export via
// `extract-pdf` or `media-extraction`. Those modules import from constants
// for internal use only; public consumers import from this barrel.
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
