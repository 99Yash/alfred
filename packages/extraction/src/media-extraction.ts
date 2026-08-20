import { getContentFamily, type ContentFamily } from "@alfred/contracts";
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
 * Door × family matrix. Every door must choose all three limits for every
 * family — `satisfies` makes a missing cell a type error (tier 1). The PDF
 * door values are the same objects that `REALTIME_PDF_EXTRACTION_LIMITS` uses;
 * other families start with the same caps and can diverge per product decision
 * without touching call sites.
 */
export const REALTIME_EXTRACTION_LIMITS = {
  chatUpload: {
    pdf: REALTIME_PDF_EXTRACTION_LIMITS.chatUpload,
    document: {
      maxBytes: 10 * 1024 * 1024,
      maxCharacters: 1_000_000,
      maxParseMilliseconds: 30_000,
      truncateOnOutputExceed: false,
    },
    spreadsheet: {
      maxBytes: 10 * 1024 * 1024,
      maxCharacters: 1_000_000,
      maxParseMilliseconds: 30_000,
      truncateOnOutputExceed: false,
    },
    text: {
      maxBytes: 10 * 1024 * 1024,
      maxCharacters: 100_000,
      maxParseMilliseconds: 5_000,
      truncateOnOutputExceed: false,
    },
  },
  fetchUrl: {
    pdf: REALTIME_PDF_EXTRACTION_LIMITS.fetchUrl,
    document: {
      maxBytes: 8_000_000,
      maxCharacters: 200_000,
      maxParseMilliseconds: 30_000,
      truncateOnOutputExceed: false,
    },
    spreadsheet: {
      maxBytes: 8_000_000,
      maxCharacters: 200_000,
      maxParseMilliseconds: 30_000,
      truncateOnOutputExceed: false,
    },
    text: {
      maxBytes: 8_000_000,
      maxCharacters: 100_000,
      maxParseMilliseconds: 5_000,
      truncateOnOutputExceed: false,
    },
  },
  gmailAttachment: {
    pdf: REALTIME_PDF_EXTRACTION_LIMITS.gmailAttachment,
    document: {
      maxBytes: 10 * 1024 * 1024,
      maxCharacters: 1_000_000,
      maxParseMilliseconds: 30_000,
      truncateOnOutputExceed: true,
    },
    spreadsheet: {
      maxBytes: 10 * 1024 * 1024,
      maxCharacters: 1_000_000,
      maxParseMilliseconds: 30_000,
      truncateOnOutputExceed: true,
    },
    text: {
      maxBytes: 10 * 1024 * 1024,
      maxCharacters: 1_000_000,
      maxParseMilliseconds: 5_000,
      truncateOnOutputExceed: true,
    },
  },
} as const satisfies Readonly<Record<ExtractionDoor, Record<ContentFamily, ExtractionLimits>>>;

/**
 * @deprecated Use `extraction({ door }).extract({ mime, bytes })` — this helper
 * leaks `ContentFamily` and `limits` to the call site. It remains for the
 * facade's internal use and for the test-only `deps.createExtractor` seam.
 */
export function extractionLimitsFor(door: ExtractionDoor, family: ContentFamily): ExtractionLimits {
  return REALTIME_EXTRACTION_LIMITS[door][family];
}

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

/**
 * Registry of family → extractor factory. `satisfies` makes a missing
 * family a type error; `as const` keeps the keys narrow. Tier 1.
 */
const MEDIA_EXTRACTOR_FACTORIES = {
  pdf: createPdfMediaExtractor,
  document: (limits: ExtractionLimits) => createOfficeMediaExtractor("document", limits),
  spreadsheet: (limits: ExtractionLimits) => createOfficeMediaExtractor("spreadsheet", limits),
  text: (limits: ExtractionLimits) => createTextMediaExtractor("text", limits),
} as const satisfies Record<ContentFamily, (limits: ExtractionLimits) => MediaExtractor>;

/**
 * @deprecated Use `extraction({ door }).forMime(mime)` or
 * `extraction({ door }).extract({ mime, bytes })` — this leaks `ContentFamily`
 * to the call site. It remains for the facade and for test-only injection.
 *
 * Create one door's extractor for one family. The hot call accepts only bytes.
 * Callers that already hold `ContentFamily` go through this; callers that hold
 * a MIME should use `createMediaExtractorForMime`.
 */
export function createMediaExtractor(door: ExtractionDoor, family: ContentFamily): MediaExtractor {
  const limits = extractionLimitsFor(door, family);
  const factory = MEDIA_EXTRACTOR_FACTORIES[family];
  return factory(limits);
}

/**
 * @deprecated Use `extraction({ door }).forMime(mime)` — this is the same
 * lookup with the same `null` for pass-through/unknown MIMEs, but via the
 * door-bound facade that memoizes per family.
 *
 * Create an extractor directly from a MIME type via `INGEST_POLICY`.
 * Returns null when the MIME is outside the whitelist or has no
 * `contentFamily` (e.g. pass-through images).
 */
export function createMediaExtractorForMime(
  door: ExtractionDoor,
  mime: string,
): MediaExtractor | null {
  const family = getContentFamily(mime);
  if (!family) return null;
  return createMediaExtractor(door, family);
}
