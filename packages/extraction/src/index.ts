// @alfred/extraction — the one deterministic reader of a PDF's bytes. Bytes in,
// pages out, with every page number 1-indexed. The wrapper is the only caller of
// `@firecrawl/pdf-inspector`; the configured reader runs it in a killable child.
export {
  createPdfExtractor,
  PdfExtractionError,
  REALTIME_PDF_EXTRACTION_LIMITS,
} from "./extract-pdf";
export {
  formatExtractedMediaText,
  formatExtractedPdfText,
  interpretPdfText,
  mediaFailureMessage,
} from "./format-extracted-pdf";
export type {
  ExtractPdf,
  ExtractedPdf,
  ExtractedPdfPage,
  InvalidPdfCause,
  PdfDocumentType,
  PdfExtractionLimitKind,
  PdfExtractionLimits,
} from "./extract-pdf";
export type { PdfTextInterpretation } from "./format-extracted-pdf";
export { FAMILY_REGISTRY } from "./media-extraction";
export type {
  ExtractionDoor,
  ExtractionLimits,
  MediaExtractionResult,
  MediaExtractor,
} from "./media-extraction";
export { extraction } from "./extraction.facade";
export type { Extraction, ExtractionOptions } from "./extraction.facade";
