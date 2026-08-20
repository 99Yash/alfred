// @alfred/extraction — the one deterministic reader of a PDF's bytes. Bytes in,
// pages out, with every page number 1-indexed. The wrapper is the only caller of
// `@firecrawl/pdf-inspector`; the configured reader runs it in a killable child.
export {
  createPdfExtractor,
  MAX_EXTRACTED_TEXT_CHARACTERS,
  PdfExtractionError,
  REALTIME_PDF_EXTRACTION_LIMITS,
} from "./extract-pdf";
export { formatExtractedPdfText, interpretPdfText } from "./format-extracted-pdf";
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
