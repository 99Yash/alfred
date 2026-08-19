// @alfred/extraction — the one deterministic reader of a PDF's bytes. Bytes in,
// pages out, with every page number 1-indexed. The wrapper is the only caller of
// `@firecrawl/pdf-inspector`; the configured reader runs it in a killable child.
export { createPdfExtractor, PdfExtractionError } from "./extract-pdf";
export type {
  ExtractPdf,
  ExtractedPdf,
  ExtractedPdfPage,
  InvalidPdfCause,
  PdfDocumentType,
  PdfExtractionLimitKind,
  PdfExtractionLimits,
} from "./extract-pdf";
