import type { ContentFormat } from "@alfred/contracts";
import { createPdfExtractor, type ExtractedPdf } from "./extract-pdf";
import { parsePdfExtractionLimits, truncateTextToFit } from "./extract-pdf-protocol";
import type { ExtractionLimits } from "./constants";

/** One result shape for every format. Only PDF has page offsets. */
export type MediaExtractionResult =
  | {
      readonly kind: "extracted";
      readonly format: ContentFormat;
      readonly content: string;
      /** PDF page offsets, else null. */
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

/** How each format turns bytes into text. A missing format is a type error. Limits are in `DOOR_LIMITS`. */
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

    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Postgres text rejects NUL. The persist sanitizer strips it too (ADR-0070).
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

/** Stub for docx and xlsx: checks the size, then returns `invalid` until a real parser exists. */
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

    // These are ZIP files. Decoding them as UTF-8 would embed binary noise.
    return { kind: "invalid", format, reason: "office extraction not yet implemented" };
  };
}
