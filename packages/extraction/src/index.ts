// @alfred/extraction — the one deterministic reader of a PDF's bytes. Bytes in,
// pages out, with every page number 1-indexed. The wrapper is the only caller of
// `@firecrawl/pdf-inspector`; see ./extract-pdf.ts for why that matters.
export { extractPdf } from "./extract-pdf";
export type {
  ExtractedPdf,
  ExtractedPdfPage,
  ExtractPdfOptions,
  PdfDocumentType,
} from "./extract-pdf";
