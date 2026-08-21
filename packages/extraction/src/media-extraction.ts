import type { ContentFamily } from "@alfred/contracts";
import {
  createPdfExtractor,
  REALTIME_PDF_EXTRACTION_LIMITS,
  type ExtractedPdf,
  type PdfExtractionLimits,
} from "./extract-pdf";
import { parsePdfExtractionLimits, truncateTextToFit } from "./extract-pdf-protocol";

// Reuse the PDF limits shape for all families — byte / char / time + optional truncation.
// Alias keeps the matrix typed without a second identical interface.
export type ExtractionLimits = PdfExtractionLimits;

export type ExtractionDoor = "chatUpload" | "fetchUrl" | "gmailAttachment";

/**
 * Normalized extraction result for any `ContentFamily`. PDF keeps page offsets;
 * text-like families produce `content` without pages. Error kinds stay identical
 * so the Gmail persist loop can handle them uniformly.
 */
export type MediaExtractionResult =
  | {
      readonly kind: "extracted";
      readonly family: ContentFamily;
      readonly content: string;
      /** Page offsets for families that prove them (pdf). Null otherwise. */
      readonly pages: readonly { page: number; start: number; end: number }[] | null;
    }
  | { readonly kind: "needs_ocr"; readonly family: ContentFamily }
  | { readonly kind: "encrypted"; readonly family: ContentFamily }
  | { readonly kind: "invalid"; readonly family: ContentFamily; readonly reason: string }
  | {
      readonly kind: "limit_exceeded";
      readonly family: ContentFamily;
      readonly limit: "input_bytes" | "output_characters" | "parse_milliseconds";
      readonly actual: number;
      readonly maximum: number;
      readonly message: string;
    };

export type MediaExtractor = (bytes: Uint8Array) => Promise<MediaExtractionResult>;

/**
 * The one family table. Each entry owns the two facts extraction needs for a
 * content family: how bytes become text (`factory`) and what each door's
 * limits are (`limitsByDoor`). The literal plus `satisfies` pins both
 * directions — a family missing here, or an entry no contract name backs,
 * is a type error. Adding a family is one `INGEST_POLICY` edit in
 * `@alfred/contracts` (the browser-safe MIME → family map stays there)
 * plus one entry here; nothing else in the repo changes.
 */
export const FAMILY_REGISTRY = {
  pdf: {
    factory: createPdfMediaExtractor,
    limitsByDoor: {
      chatUpload: REALTIME_PDF_EXTRACTION_LIMITS.chatUpload,
      fetchUrl: REALTIME_PDF_EXTRACTION_LIMITS.fetchUrl,
      gmailAttachment: REALTIME_PDF_EXTRACTION_LIMITS.gmailAttachment,
    },
  },
  document: {
    factory: (limits: ExtractionLimits) => createOfficeMediaExtractor("document", limits),
    limitsByDoor: {
      chatUpload: {
        maxBytes: 10 * 1024 * 1024,
        maxCharacters: 1_000_000,
        maxParseMilliseconds: 30_000,
        truncateOnOutputExceed: false,
      },
      fetchUrl: {
        maxBytes: 8_000_000,
        maxCharacters: 200_000,
        maxParseMilliseconds: 30_000,
        truncateOnOutputExceed: false,
      },
      gmailAttachment: {
        maxBytes: 10 * 1024 * 1024,
        maxCharacters: 1_000_000,
        maxParseMilliseconds: 30_000,
        truncateOnOutputExceed: true,
      },
    },
  },
  spreadsheet: {
    factory: (limits: ExtractionLimits) => createOfficeMediaExtractor("spreadsheet", limits),
    limitsByDoor: {
      chatUpload: {
        maxBytes: 10 * 1024 * 1024,
        maxCharacters: 1_000_000,
        maxParseMilliseconds: 30_000,
        truncateOnOutputExceed: false,
      },
      fetchUrl: {
        maxBytes: 8_000_000,
        maxCharacters: 200_000,
        maxParseMilliseconds: 30_000,
        truncateOnOutputExceed: false,
      },
      gmailAttachment: {
        maxBytes: 10 * 1024 * 1024,
        maxCharacters: 1_000_000,
        maxParseMilliseconds: 30_000,
        truncateOnOutputExceed: true,
      },
    },
  },
  text: {
    factory: (limits: ExtractionLimits) => createTextMediaExtractor("text", limits),
    limitsByDoor: {
      chatUpload: {
        maxBytes: 10 * 1024 * 1024,
        maxCharacters: 100_000,
        maxParseMilliseconds: 5_000,
        truncateOnOutputExceed: false,
      },
      fetchUrl: {
        maxBytes: 8_000_000,
        maxCharacters: 100_000,
        maxParseMilliseconds: 5_000,
        truncateOnOutputExceed: false,
      },
      gmailAttachment: {
        maxBytes: 10 * 1024 * 1024,
        maxCharacters: 1_000_000,
        maxParseMilliseconds: 5_000,
        truncateOnOutputExceed: true,
      },
    },
  },
} as const satisfies Readonly<
  Record<
    ContentFamily,
    {
      readonly factory: (limits: ExtractionLimits) => MediaExtractor;
      readonly limitsByDoor: Readonly<Record<ExtractionDoor, ExtractionLimits>>;
    }
  >
>;

// ---------------------------------------------------------------------------
// Family extractors
// ---------------------------------------------------------------------------

function pdfResultToMedia(result: ExtractedPdf, family: ContentFamily): MediaExtractionResult {
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
        family,
        content,
        pages: pageOffsets.length > 0 ? pageOffsets : null,
      };
    }
    case "text_without_pages":
      return { kind: "extracted", family, content: result.text, pages: null };
    case "needs_ocr":
      return { kind: "needs_ocr", family };
    case "encrypted":
      return { kind: "encrypted", family };
    case "invalid":
      return { kind: "invalid", family, reason: result.reason };
    case "limit_exceeded":
      return {
        kind: "limit_exceeded",
        family,
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

export function mediaResultFromExtractedPdf(result: ExtractedPdf): MediaExtractionResult {
  return pdfResultToMedia(result, "pdf");
}

function createPdfMediaExtractor(limits: ExtractionLimits): MediaExtractor {
  const pdfExtractor = createPdfExtractor(parsePdfExtractionLimits(limits));
  return async (bytes) => {
    const result = await pdfExtractor(bytes);
    return pdfResultToMedia(result, "pdf");
  };
}

function createTextMediaExtractor(family: ContentFamily, limits: ExtractionLimits): MediaExtractor {
  const parsed = parsePdfExtractionLimits(limits);
  return async (bytes) => {
    if (bytes.byteLength > parsed.maxBytes) {
      return {
        kind: "limit_exceeded",
        family,
        limit: "input_bytes",
        actual: bytes.byteLength,
        maximum: parsed.maxBytes,
        message: `input byte limit exceeded: ${bytes.byteLength} > ${parsed.maxBytes}`,
      };
    }
    if (bytes.byteLength === 0) {
      return { kind: "invalid", family, reason: "empty file" };
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
          family,
          limit: "output_characters",
          actual: text.length,
          maximum: parsed.maxCharacters,
          message: `output character limit exceeded: ${text.length} > ${parsed.maxCharacters}`,
        };
      }
    }
    if (text.trim().length === 0) {
      return { kind: "invalid", family, reason: "empty text" };
    }
    return { kind: "extracted", family, content: text, pages: null };
  };
}

/**
 * Stub docx/spreadsheet extractor. Until a real office parser lands, enforce
 * limits and then return `invalid` so the ingest skips without embedding zip
 * garbage. Wiring the real parser is a one-line swap here (tier 3 ownership)
 * without touching Gmail ingest.
 */
function createOfficeMediaExtractor(
  family: ContentFamily,
  limits: ExtractionLimits,
): MediaExtractor {
  const parsed = parsePdfExtractionLimits(limits);
  return async (bytes) => {
    if (bytes.byteLength > parsed.maxBytes) {
      return {
        kind: "limit_exceeded",
        family,
        limit: "input_bytes",
        actual: bytes.byteLength,
        maximum: parsed.maxBytes,
        message: `input byte limit exceeded: ${bytes.byteLength} > ${parsed.maxBytes}`,
      };
    }
    // Docx/xlsx are ZIP containers (PK header). Don't decode as UTF-8 — we'd
    // embed binary noise. Signal `invalid` until a real parser replaces this.
    return { kind: "invalid", family, reason: "office extraction not yet implemented" };
  };
}
