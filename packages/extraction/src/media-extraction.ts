import type { ContentFormat } from "@alfred/contracts";
import { createPdfExtractor, type ExtractedPdf } from "./extract-pdf";
import { parsePdfExtractionLimits, truncateTextToFit } from "./extract-pdf-protocol";
import type { ExtractionLimits } from "./constants";

/**
 * Normalized extraction result for any `ContentFormat`. PDF keeps page offsets;
 * text-like formats produce `content` without pages. Error kinds stay identical
 * so the Gmail persist loop can handle them uniformly.
 */
export type MediaExtractionResult =
  | {
      readonly kind: "extracted";
      readonly format: ContentFormat;
      readonly content: string;
      /** Page offsets for formats that prove them (pdf). Null otherwise. */
      readonly pages: readonly { page: number; start: number; end: number }[] | null;
    }
  | { readonly kind: "needs_ocr"; readonly format: ContentFormat }
  | { readonly kind: "encrypted"; readonly format: ContentFormat }
  | { readonly kind: "invalid"; readonly format: ContentFormat; readonly reason: string }
  | {
      readonly kind: "limit_exceeded";
      readonly format: ContentFormat;
      readonly limit: "input_bytes" | "output_characters" | "parse_milliseconds";
      readonly actual: number;
      readonly maximum: number;
      readonly message: string;
    };

export type MediaExtractor = (bytes: Uint8Array) => Promise<MediaExtractionResult>;

/**
 * The one format table. Each entry owns the one fact extraction needs for a
 * content format: how bytes become text (`factory`). Limits live beside it in
 * `DOOR_LIMITS`. The literal plus `satisfies` pins the direction — a format
 * missing here, or an entry no contract name backs, is a type error. Adding a
 * format is one `INGEST_POLICY` edit in `@alfred/contracts` (the browser-safe
 * MIME → format map stays there), one entry here, and one `DOOR_LIMITS` row;
 * nothing else in the repo changes.
 */
export const FORMAT_REGISTRY = {
  pdf: {
    factory: createPdfMediaExtractor,
  },
  document: {
    factory: (limits: ExtractionLimits) => createOfficeMediaExtractor("document", limits),
  },
  spreadsheet: {
    factory: (limits: ExtractionLimits) => createOfficeMediaExtractor("spreadsheet", limits),
  },
  text: {
    factory: (limits: ExtractionLimits) => createTextMediaExtractor("text", limits),
  },
} as const satisfies Readonly<
  Record<
    ContentFormat,
    {
      readonly factory: (limits: ExtractionLimits) => MediaExtractor;
    }
  >
>;

// ---------------------------------------------------------------------------
// Format extractors
// ---------------------------------------------------------------------------

function pdfResultToMedia(result: ExtractedPdf, format: ContentFormat): MediaExtractionResult {
  switch (result.kind) {
    case "extracted": {
      const markdowns: string[] = [];
      const pageOffsets: { page: number; start: number; end: number }[] = [];
      let offset = 0;
      for (const [idx, page] of result.pages.entries()) {
        const text = page.markdown;
        markdowns.push(text);
        if (text.length > 0) {
          const start = offset;
          const end = start + text.length;
          pageOffsets.push({ page: page.pageNumber, start, end });
        }
        offset += text.length;
        if (idx < result.pages.length - 1) offset += 2; // "\n\n"
      }
      const content = markdowns.join("\n\n");
      return {
        kind: "extracted",
        format,
        content,
        pages: pageOffsets.length > 0 ? pageOffsets : null,
      };
    }
    case "text_without_pages":
      return { kind: "extracted", format, content: result.text, pages: null };
    case "needs_ocr":
      return { kind: "needs_ocr", format };
    case "encrypted":
      return { kind: "encrypted", format };
    case "invalid":
      return { kind: "invalid", format, reason: result.reason };
    case "limit_exceeded":
      return {
        kind: "limit_exceeded",
        format,
        limit: result.limit,
        actual: result.actual,
        maximum: result.maximum,
        message: result.message,
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function createPdfMediaExtractor(limits: ExtractionLimits): MediaExtractor {
  const pdfExtractor = createPdfExtractor(parsePdfExtractionLimits(limits));
  return async (bytes) => {
    const result = await pdfExtractor(bytes);
    return pdfResultToMedia(result, "pdf");
  };
}

function createTextMediaExtractor(format: ContentFormat, limits: ExtractionLimits): MediaExtractor {
  const parsed = parsePdfExtractionLimits(limits);
  return async (bytes) => {
    if (bytes.byteLength > parsed.maxBytes) {
      return {
        kind: "limit_exceeded",
        format,
        limit: "input_bytes",
        actual: bytes.byteLength,
        maximum: parsed.maxBytes,
        message: `input byte limit exceeded: ${bytes.byteLength} > ${parsed.maxBytes}`,
      };
    }
    if (bytes.byteLength === 0) {
      return { kind: "invalid", format, reason: "empty file" };
    }
    // NUL-safe decode — strip controls that would poison the document table.
    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Remove NUL bytes (ADR-0070 sanitizer also does this at persist, but
    // the extractor should not produce them).
    text = text.replace(/\0/g, "");
    if (text.length > parsed.maxCharacters) {
      if (parsed.truncateOnOutputExceed) {
        text = truncateTextToFit(text, parsed.maxCharacters);
      } else {
        return {
          kind: "limit_exceeded",
          format,
          limit: "output_characters",
          actual: text.length,
          maximum: parsed.maxCharacters,
          message: `output character limit exceeded: ${text.length} > ${parsed.maxCharacters}`,
        };
      }
    }
    if (text.trim().length === 0) {
      return { kind: "invalid", format, reason: "empty text" };
    }
    return { kind: "extracted", format, content: text, pages: null };
  };
}

/**
 * Stub docx/spreadsheet extractor. Until a real office parser lands, enforce
 * limits and then return `invalid` so the ingest skips without embedding zip
 * garbage. Wiring the real parser is a one-line swap here (tier 3 ownership)
 * without touching Gmail ingest.
 */
function createOfficeMediaExtractor(
  format: ContentFormat,
  limits: ExtractionLimits,
): MediaExtractor {
  const parsed = parsePdfExtractionLimits(limits);
  return async (bytes) => {
    if (bytes.byteLength > parsed.maxBytes) {
      return {
        kind: "limit_exceeded",
        format,
        limit: "input_bytes",
        actual: bytes.byteLength,
        maximum: parsed.maxBytes,
        message: `input byte limit exceeded: ${bytes.byteLength} > ${parsed.maxBytes}`,
      };
    }
    // Docx/xlsx are ZIP containers (PK header). Don't decode as UTF-8 — we'd
    // embed binary noise. Signal `invalid` until a real parser replaces this.
    return { kind: "invalid", format, reason: "office extraction not yet implemented" };
  };
}
