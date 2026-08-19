import type {
  ExtractedPdf,
  ExtractedPdfPage,
  PdfDocumentType,
  PdfExtractionLimitKind,
  PdfExtractionLimits,
} from "./extract-pdf";

// Keep this child-process protocol dependency-free. In particular, do not
// import @alfred/contracts guards: extraction intentionally has only the pinned
// PDF vendor as a runtime dependency.

export type PdfExtractionChildReply =
  | { readonly kind: "result"; readonly result: ExtractedPdf }
  | {
      readonly kind: "dependency_error";
      readonly error: {
        readonly source: "native_load" | "pdf_extraction";
        readonly name: string;
        readonly message: string;
        readonly code?: string;
      };
    };

export interface PdfExtractionChildRequest {
  readonly limits: PdfExtractionLimits;
  readonly bytes: Uint8Array;
}

const MAX_HEADER_BYTES = 4_096;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

type LimitMessage = (actual: number, maximum: number) => string;

const PDF_EXTRACTION_LIMIT_MESSAGES = {
  input_bytes: (actual, maximum) => `PDF input byte limit exceeded: ${actual} > ${maximum}`,
  output_characters: (actual, maximum) =>
    `PDF output character limit exceeded: ${actual} > ${maximum}`,
  parse_milliseconds: (actual, maximum) =>
    `PDF parse deadline exceeded: ${actual}ms >= ${maximum}ms`,
} satisfies Readonly<Record<PdfExtractionLimitKind, LimitMessage>>;

const PDF_EXTRACTION_RESULT_KINDS = {
  encrypted: true,
  extracted: true,
  invalid: true,
  limit_exceeded: true,
  needs_ocr: true,
  text_without_pages: true,
} as const satisfies Readonly<Record<ExtractedPdf["kind"], true>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function positiveSafeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function isPdfExtractionLimitKind(value: unknown): value is PdfExtractionLimitKind {
  return typeof value === "string" && Object.hasOwn(PDF_EXTRACTION_LIMIT_MESSAGES, value);
}

function isPdfExtractionResultKind(value: unknown): value is ExtractedPdf["kind"] {
  return typeof value === "string" && Object.hasOwn(PDF_EXTRACTION_RESULT_KINDS, value);
}

export function parsePdfExtractionLimits(value: unknown): PdfExtractionLimits {
  if (!isRecord(value)) throw new RangeError("PDF extraction limits must be an object");
  const maxParseMilliseconds = positiveSafeInteger(
    "maxParseMilliseconds",
    value.maxParseMilliseconds,
  );
  if (maxParseMilliseconds > MAX_TIMER_MILLISECONDS) {
    throw new RangeError(`maxParseMilliseconds must be at most ${MAX_TIMER_MILLISECONDS}`);
  }
  return {
    maxBytes: positiveSafeInteger("maxBytes", value.maxBytes),
    maxCharacters: positiveSafeInteger("maxCharacters", value.maxCharacters),
    maxParseMilliseconds,
  };
}

export function createPdfExtractionLimitResult(
  limit: PdfExtractionLimitKind,
  actual: number,
  maximum: number,
): ExtractedPdf {
  const message = PDF_EXTRACTION_LIMIT_MESSAGES[limit](actual, maximum);
  return { kind: "limit_exceeded", limit, actual, maximum, message };
}

function isValidLimitActual(
  limit: PdfExtractionLimitKind,
  actual: number,
  maximum: number,
): boolean {
  switch (limit) {
    case "input_bytes":
    case "output_characters":
      return actual > maximum;
    case "parse_milliseconds":
      return actual >= maximum;
    default: {
      const _exhaustive: never = limit;
      return _exhaustive;
    }
  }
}

interface MetadataField {
  readonly kind: "metadata";
}

interface ContentField<T> {
  readonly kind: "content";
  readonly characterCount: (value: T) => number;
}

type ContentFieldClassification<T> = {
  readonly [Field in keyof T]-?: MetadataField | ContentField<T>;
};

type ExtractedPdfOfKind<Kind extends ExtractedPdf["kind"]> = Extract<
  ExtractedPdf,
  { readonly kind: Kind }
>;

type ExtractedPdfContentFieldClassifications = {
  readonly [Kind in ExtractedPdf["kind"]]: ContentFieldClassification<ExtractedPdfOfKind<Kind>>;
};

type PdfExtractionClassifiedFields =
  | ContentFieldClassification<ExtractedPdfPage>
  | ExtractedPdfContentFieldClassifications[ExtractedPdf["kind"]];

function hasOnlyClassifiedFields(
  record: Record<string, unknown>,
  fields: PdfExtractionClassifiedFields,
): boolean {
  return hasOnlyKeys(record, Object.keys(fields));
}

const METADATA_FIELD = { kind: "metadata" } as const satisfies MetadataField;

function classifiedContentCharacterCount<T extends object>(
  value: T,
  fields: ContentFieldClassification<T>,
): number {
  let total = 0;
  for (const field in fields) {
    const classification = fields[field];
    if (classification.kind === "content") {
      total += classification.characterCount(value);
    }
  }
  return total;
}

const PDF_EXTRACTION_PAGE_CONTENT_FIELDS = {
  pageNumber: METADATA_FIELD,
  markdown: {
    kind: "content",
    characterCount: (page) => page.markdown.length,
  },
  needsOcr: METADATA_FIELD,
  ocrReason: METADATA_FIELD,
} satisfies ContentFieldClassification<ExtractedPdfPage>;

export function pdfExtractionPageCharacterCount(pages: readonly ExtractedPdfPage[]): number {
  return pages.reduce(
    (total, page) =>
      total + classifiedContentCharacterCount(page, PDF_EXTRACTION_PAGE_CONTENT_FIELDS),
    0,
  );
}

const PDF_EXTRACTION_RESULT_CONTENT_FIELDS = {
  extracted: {
    kind: METADATA_FIELD,
    pdfType: METADATA_FIELD,
    pageCount: METADATA_FIELD,
    pages: {
      kind: "content",
      characterCount: (result) => pdfExtractionPageCharacterCount(result.pages),
    },
    pagesNeedingOcr: METADATA_FIELD,
    text: {
      kind: "content",
      characterCount: (result) => result.text.length,
    },
  },
  text_without_pages: {
    kind: METADATA_FIELD,
    pdfType: METADATA_FIELD,
    pageCount: METADATA_FIELD,
    text: {
      kind: "content",
      characterCount: (result) => result.text.length,
    },
  },
  needs_ocr: {
    kind: METADATA_FIELD,
    pdfType: METADATA_FIELD,
    pageCount: METADATA_FIELD,
  },
  encrypted: {
    kind: METADATA_FIELD,
  },
  invalid: {
    kind: METADATA_FIELD,
    cause: METADATA_FIELD,
    reason: METADATA_FIELD,
  },
  limit_exceeded: {
    kind: METADATA_FIELD,
    limit: METADATA_FIELD,
    actual: METADATA_FIELD,
    maximum: METADATA_FIELD,
    message: METADATA_FIELD,
  },
} satisfies ExtractedPdfContentFieldClassifications;

/** The one projection of public extraction results onto bounded content. */
export function pdfExtractionContentCharacterCount(result: ExtractedPdf): number {
  switch (result.kind) {
    case "extracted":
      return classifiedContentCharacterCount(
        result,
        PDF_EXTRACTION_RESULT_CONTENT_FIELDS.extracted,
      );
    case "text_without_pages":
      return classifiedContentCharacterCount(
        result,
        PDF_EXTRACTION_RESULT_CONTENT_FIELDS.text_without_pages,
      );
    case "needs_ocr":
      return classifiedContentCharacterCount(
        result,
        PDF_EXTRACTION_RESULT_CONTENT_FIELDS.needs_ocr,
      );
    case "encrypted":
      return classifiedContentCharacterCount(
        result,
        PDF_EXTRACTION_RESULT_CONTENT_FIELDS.encrypted,
      );
    case "invalid":
      return classifiedContentCharacterCount(result, PDF_EXTRACTION_RESULT_CONTENT_FIELDS.invalid);
    case "limit_exceeded":
      return classifiedContentCharacterCount(
        result,
        PDF_EXTRACTION_RESULT_CONTENT_FIELDS.limit_exceeded,
      );
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export function serializePdfExtractionChildRequest(
  limits: PdfExtractionLimits,
  bytes: Uint8Array,
): Buffer {
  const header = Buffer.from(`${JSON.stringify({ limits, byteLength: bytes.byteLength })}\n`);
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Buffer.concat([header, body]);
}

function parseRequestHeader(value: unknown): {
  readonly limits: PdfExtractionLimits;
  readonly byteLength: number;
} {
  if (!isRecord(value) || !hasOnlyKeys(value, ["limits", "byteLength"])) {
    throw new Error("Invalid PDF extraction child request header");
  }
  // Protocol input is untrusted, so validate the limits again at this decode boundary.
  const limits = parsePdfExtractionLimits(value.limits);
  const byteLength = value.byteLength;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("Invalid PDF extraction child request byte length");
  }
  if (byteLength > limits.maxBytes) {
    throw new Error("PDF extraction child request exceeds maxBytes");
  }
  return { limits, byteLength };
}

export async function readPdfExtractionChildRequest(
  input: NodeJS.ReadableStream & AsyncIterable<string | Buffer>,
): Promise<PdfExtractionChildRequest> {
  const headerParts: Buffer[] = [];
  const bodyParts: Buffer[] = [];
  let headerBytes = 0;
  let bodyBytes = 0;
  let header: { readonly limits: PdfExtractionLimits; readonly byteLength: number } | undefined;

  for await (const inputChunk of input) {
    let chunk = typeof inputChunk === "string" ? Buffer.from(inputChunk) : inputChunk;
    if (header === undefined) {
      const newline = chunk.indexOf(0x0a);
      const headerChunk = newline === -1 ? chunk : chunk.subarray(0, newline);
      headerBytes += headerChunk.byteLength;
      if (headerBytes > MAX_HEADER_BYTES)
        throw new Error("PDF extraction child header is too large");
      headerParts.push(headerChunk);
      if (newline === -1) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(headerParts).toString("utf8"));
      } catch (error) {
        throw new Error("PDF extraction child header is not valid JSON", { cause: error });
      }
      header = parseRequestHeader(parsed);
      chunk = chunk.subarray(newline + 1);
    }

    bodyBytes += chunk.byteLength;
    if (bodyBytes > header.byteLength) {
      throw new Error("PDF extraction child request has trailing bytes");
    }
    bodyParts.push(chunk);
  }

  if (header === undefined) throw new Error("PDF extraction child request has no header");
  if (bodyBytes !== header.byteLength) throw new Error("PDF extraction child request is truncated");
  return { limits: header.limits, bytes: new Uint8Array(Buffer.concat(bodyParts)) };
}

function parsePdfDocumentType(value: unknown): PdfDocumentType {
  if (
    value !== "text_based" &&
    value !== "scanned" &&
    value !== "image_based" &&
    value !== "mixed"
  ) {
    throw new Error("Invalid PDF document type in child reply");
  }
  return value;
}

function nonnegativeSafeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function parsePage(value: unknown): ExtractedPdfPage {
  if (!isRecord(value)) throw new Error("Invalid page in PDF extraction child reply");
  const allowedKeys = Object.keys(PDF_EXTRACTION_PAGE_CONTENT_FIELDS).filter(
    (key) => key !== "ocrReason" || value.ocrReason !== undefined,
  );
  if (!hasOnlyKeys(value, allowedKeys)) throw new Error("Invalid page fields in child reply");
  const pageNumber = positiveSafeInteger("pageNumber", value.pageNumber);
  if (typeof value.markdown !== "string" || typeof value.needsOcr !== "boolean") {
    throw new Error("Invalid page values in PDF extraction child reply");
  }
  if (value.ocrReason !== undefined && typeof value.ocrReason !== "string") {
    throw new Error("Invalid page OCR reason in PDF extraction child reply");
  }
  return {
    pageNumber,
    markdown: value.markdown,
    needsOcr: value.needsOcr,
    ...(value.ocrReason === undefined ? {} : { ocrReason: value.ocrReason }),
  };
}

function parseResult(value: unknown): ExtractedPdf {
  if (!isRecord(value) || !isPdfExtractionResultKind(value.kind)) {
    throw new Error("Invalid PDF extraction result in child reply");
  }

  const { kind } = value;
  switch (kind) {
    case "encrypted":
      if (!hasOnlyClassifiedFields(value, PDF_EXTRACTION_RESULT_CONTENT_FIELDS.encrypted)) {
        throw new Error("Invalid encrypted result fields");
      }
      return { kind: "encrypted" };
    case "invalid": {
      if (!hasOnlyClassifiedFields(value, PDF_EXTRACTION_RESULT_CONTENT_FIELDS.invalid)) {
        throw new Error("Invalid rejected PDF result fields");
      }
      if (value.cause !== "not_a_pdf" && value.cause !== "damaged") {
        throw new Error("Invalid rejected PDF cause");
      }
      if (typeof value.reason !== "string") throw new Error("Invalid rejected PDF reason");
      return { kind: "invalid", cause: value.cause, reason: value.reason };
    }
    case "needs_ocr": {
      if (!hasOnlyClassifiedFields(value, PDF_EXTRACTION_RESULT_CONTENT_FIELDS.needs_ocr)) {
        throw new Error("Invalid needs-OCR result fields");
      }
      return {
        kind: "needs_ocr",
        pdfType: parsePdfDocumentType(value.pdfType),
        pageCount: nonnegativeSafeInteger("pageCount", value.pageCount),
      };
    }
    case "text_without_pages": {
      if (
        !hasOnlyClassifiedFields(value, PDF_EXTRACTION_RESULT_CONTENT_FIELDS.text_without_pages)
      ) {
        throw new Error("Invalid page-free text result fields");
      }
      if (typeof value.text !== "string") throw new Error("Invalid page-free PDF text");
      return {
        kind: "text_without_pages",
        pdfType: parsePdfDocumentType(value.pdfType),
        pageCount: nonnegativeSafeInteger("pageCount", value.pageCount),
        text: value.text,
      };
    }
    case "extracted": {
      if (!hasOnlyClassifiedFields(value, PDF_EXTRACTION_RESULT_CONTENT_FIELDS.extracted)) {
        throw new Error("Invalid extracted PDF result fields");
      }
      if (!Array.isArray(value.pages) || !Array.isArray(value.pagesNeedingOcr)) {
        throw new Error("Invalid extracted PDF arrays");
      }
      if (typeof value.text !== "string") throw new Error("Invalid extracted PDF text");
      const pages = value.pages.map(parsePage);
      const pageCount = nonnegativeSafeInteger("pageCount", value.pageCount);
      if (
        pageCount !== pages.length ||
        pages.some((page, index) => page.pageNumber !== index + 1)
      ) {
        throw new Error("Invalid extracted PDF page sequence");
      }
      const pagesNeedingOcr = value.pagesNeedingOcr.map((page) =>
        positiveSafeInteger("pagesNeedingOcr", page),
      );
      const derivedOcrPages = pages.filter((page) => page.needsOcr).map((page) => page.pageNumber);
      if (
        pagesNeedingOcr.length !== derivedOcrPages.length ||
        pagesNeedingOcr.some((page, index) => page !== derivedOcrPages[index])
      ) {
        throw new Error("Invalid extracted PDF OCR page list");
      }
      return {
        kind: "extracted",
        pdfType: parsePdfDocumentType(value.pdfType),
        pageCount,
        pages,
        pagesNeedingOcr,
        text: value.text,
      };
    }
    case "limit_exceeded": {
      if (!hasOnlyClassifiedFields(value, PDF_EXTRACTION_RESULT_CONTENT_FIELDS.limit_exceeded)) {
        throw new Error("Invalid PDF limit result fields");
      }
      if (!isPdfExtractionLimitKind(value.limit)) {
        throw new Error("Invalid PDF limit kind");
      }
      const actual = nonnegativeSafeInteger("actual", value.actual);
      const maximum = positiveSafeInteger("maximum", value.maximum);
      const expectedMessage = PDF_EXTRACTION_LIMIT_MESSAGES[value.limit](actual, maximum);
      if (value.message !== expectedMessage || !isValidLimitActual(value.limit, actual, maximum)) {
        throw new Error("Invalid PDF limit result values");
      }
      return {
        kind: "limit_exceeded",
        limit: value.limit,
        actual,
        maximum,
        message: value.message,
      };
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function parseDependencyError(value: unknown): PdfExtractionChildReply {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "error"]) || !isRecord(value.error)) {
    throw new Error("Invalid PDF dependency error reply");
  }
  const allowedErrorKeys =
    value.error.code === undefined
      ? ["source", "name", "message"]
      : ["source", "name", "message", "code"];
  if (!hasOnlyKeys(value.error, allowedErrorKeys))
    throw new Error("Invalid dependency error fields");
  if (value.error.source !== "native_load" && value.error.source !== "pdf_extraction") {
    throw new Error("Invalid dependency error source");
  }
  if (typeof value.error.name !== "string" || typeof value.error.message !== "string") {
    throw new Error("Invalid dependency error values");
  }
  if (value.error.code !== undefined && typeof value.error.code !== "string") {
    throw new Error("Invalid dependency error code");
  }
  return {
    kind: "dependency_error",
    error: {
      source: value.error.source,
      name: value.error.name,
      message: value.error.message,
      ...(value.error.code === undefined ? {} : { code: value.error.code }),
    },
  };
}

export function parsePdfExtractionChildReply(output: Buffer): PdfExtractionChildReply {
  if (output.length === 0 || output.at(-1) !== 0x0a) {
    throw new Error("PDF extraction child reply must end with one newline");
  }
  const line = output.subarray(0, -1);
  if (line.includes(0x0a)) throw new Error("PDF extraction child returned more than one reply");

  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch (error) {
    throw new Error("PDF extraction child reply is not valid JSON", { cause: error });
  }
  if (!isRecord(value) || (value.kind !== "result" && value.kind !== "dependency_error")) {
    throw new Error("Invalid PDF extraction child reply");
  }
  if (value.kind === "dependency_error") return parseDependencyError(value);
  if (!hasOnlyKeys(value, ["kind", "result"])) throw new Error("Invalid PDF result reply fields");
  return { kind: "result", result: parseResult(value.result) };
}

export function serializePdfExtractionChildReply(reply: PdfExtractionChildReply): string {
  return `${JSON.stringify(reply)}\n`;
}
