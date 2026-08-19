// The single seam between Alfred and a PDF's bytes. Every door — `fetch_url`, a
// chat upload, corpus ingestion — reads a PDF through `extractPdf` and nothing
// else calls `@firecrawl/pdf-inspector` directly.
//
// The seam earns its own module for two reasons, and both are load-bearing:
//
//   1. INDEX BASE. The library reports OCR pages 0-indexed from `classifyPdf`
//      and 1-indexed from `extractPagesMarkdown` — for the same document, in the
//      same call graph. `PageMarkdownResult.page` is 0-indexed while
//      `PagesExtractionResult.pagesNeedingOcr` is 1-indexed. A page number the
//      boss states to a user must not be a fabrication, so exactly one module
//      owns the conversion. Everything this module returns is 1-indexed.
//   2. FAILURE SHAPE. Every library failure arrives as `Error` with
//      `code: "GenericFailure"` and a message of the form `"<rust_fn>: <reason>"`.
//      There is no typed error class and no distinct code, so the message is the
//      only discriminator. That mapping lives here, in one function, behind a
//      pinned version and a tracked fixture per message.
//
// The rule that decides what is a returned value and what is a thrown error:
// a value describes an outcome that depends on the INPUT, a throw describes an
// outcome that depends on the INSTALLATION. So an encrypted, scanned, invalid or
// oversized document is a variant of `ExtractedPdf`.
//
// `extractPdf` throws in exactly two cases, and a door must treat both as a
// dependency problem rather than a fact about the document:
//
//   * the native binary cannot load (no platform build, or a failed
//     optional-dependency install);
//   * the library fails with a message this module does not recognize. Mapping
//     every unrecognized `GenericFailure` to `invalid` would report a broken
//     install or an out-of-memory as "your PDF is corrupt", so it rethrows.
//
// The document-level verdict comes from the PAGES, never from the library's
// `pdfType`. `pdfType` is a whole-document prediction with a text-density
// threshold behind it: an `ImageBased` scan with a born-digital cover page
// still holds readable text on that cover, and a `TextBased` document at
// confidence 1.00 can yield empty markdown on every page. Both are reproduced
// by tracked fixtures. So this module always runs the per-page extraction and
// reads the answer off the pages; `pdfType` is carried as metadata only.

import type { PdfType } from "@firecrawl/pdf-inspector";

/** The library's `PdfType`, in this repo's casing. */
export type PdfDocumentType = "text_based" | "scanned" | "image_based" | "mixed";

export interface ExtractedPdfPage {
  /** 1-indexed, always. The library reports this page 0-indexed. */
  readonly pageNumber: number;
  /** The page's text as markdown. Empty when the page carries no readable text. */
  readonly markdown: string;
  readonly needsOcr: boolean;
  /** Vendor reason, an OPEN vocabulary: `"scanned"`, `"suspected_garbled_text"`, … */
  readonly ocrReason?: string;
}

/**
 * Every outcome `extractPdf` can report. A door reads `kind` first; the variants
 * carry different fields, so a door that forgets one gets a type error at the
 * field read rather than a wrong answer at runtime.
 */
export type ExtractedPdf =
  | {
      readonly kind: "extracted";
      /** Reported metadata, not a verdict. The verdict is `kind`. */
      readonly pdfType: PdfDocumentType;
      /** `pages.length`, so a door can never read past the end of `pages`. */
      readonly pageCount: number;
      readonly pages: readonly ExtractedPdfPage[];
      /** 1-indexed. Derived from `pages`, so it can never disagree with them. */
      readonly pagesNeedingOcr: readonly number[];
    }
  /**
   * Not one page of this document carried readable text, so there is nothing to
   * read without OCR. This is the only variant a model ever sees, and it
   * deliberately carries NO `pages` array — nothing downstream can assert a page
   * number for a document nobody read. `pageCount` therefore comes from the
   * classifier, which is the only count left.
   */
  | { readonly kind: "needs_ocr"; readonly pdfType: PdfDocumentType; readonly pageCount: number }
  | { readonly kind: "encrypted" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "too_large"; readonly byteLength: number; readonly maxBytes: number };

export interface ExtractPdfOptions {
  /**
   * Input hygiene. Each door passes its own cap, because each door's bytes come
   * from a different place. Required: a door that omits it does not compile.
   */
  readonly maxBytes: number;
}

/**
 * The library's four `PdfType` labels, in this repo's casing. The key type is the
 * vendor's own enum, so a label the vendor renames or adds fails to compile here
 * instead of reading as a silent default.
 *
 * The key is written `` `${PdfType}` `` rather than `PdfType`, because `PdfType`
 * is a `const enum`: its members have no runtime value under `isolatedModules`,
 * so they cannot be written as object keys. The template form is the same union
 * of string literals, which the literal keys below do satisfy, and it erases
 * completely.
 */
const PDF_DOCUMENT_TYPES: Readonly<Record<`${PdfType}`, PdfDocumentType>> = {
  TextBased: "text_based",
  Scanned: "scanned",
  ImageBased: "image_based",
  Mixed: "mixed",
};

/**
 * Vendor message substrings, each mapped to the variant it means. Order matters
 * only in that the first match wins; the three substrings are disjoint today.
 *
 * A vendor reword breaks this table, which is why the version is pinned exactly
 * and why every row has a tracked fixture asserting it. A reword then shows up
 * as a red CI row instead of Alfred telling a user their password-protected
 * statement is a corrupt file.
 */
const ENCRYPTED_MESSAGE = "PDF is encrypted";
const INVALID_MESSAGE_SUBSTRINGS: readonly string[] = ["Not a PDF", "Invalid PDF structure"];

/** `"<rust_fn_name>: "` — the prefix every library message carries. */
const RUST_FUNCTION_PREFIX = /^[a-z][a-z0-9_]*: /;

type PdfInspector = typeof import("@firecrawl/pdf-inspector");

/**
 * The library's `index.js` throws at REQUIRE time when no platform binary loads,
 * so a static top-level import would turn a failed optional-dependency install —
 * or any Intel Mac, for which no build exists — into a boot failure of the whole
 * server. A memoized dynamic import confines that to the first `extractPdf` call.
 *
 * The promise is memoized rather than the module, so concurrent first calls share
 * one load. A rejection is memoized too, and correctly: a missing binary does not
 * heal between calls.
 */
let inspectorPromise: Promise<PdfInspector> | undefined;

function loadInspector(): Promise<PdfInspector> {
  inspectorPromise ??= import("@firecrawl/pdf-inspector");
  return inspectorPromise;
}

/** The vendor's label, in this repo's casing. Total over the vendor's enum. */
function toPdfDocumentType(pdfType: PdfType): PdfDocumentType {
  return PDF_DOCUMENT_TYPES[pdfType];
}

/**
 * The variant a library failure means, or `undefined` when the failure is not one
 * this module recognizes.
 *
 * `undefined` is the important half. Mapping every `GenericFailure` to `invalid`
 * would report a broken install, an out-of-memory, or any error a future version
 * adds as "your PDF is corrupt". An unrecognized failure is rethrown instead.
 */
function toExtractedPdfFailure(error: unknown): ExtractedPdf | undefined {
  if (!(error instanceof Error)) return undefined;
  const { message } = error;
  if (message.includes(ENCRYPTED_MESSAGE)) return { kind: "encrypted" };
  if (INVALID_MESSAGE_SUBSTRINGS.some((substring) => message.includes(substring))) {
    return { kind: "invalid", reason: message.replace(RUST_FUNCTION_PREFIX, "") };
  }
  return undefined;
}

/**
 * A page counts as read when it carries any non-whitespace text. The library
 * returns `""` for a page it could not read, and `needsOcr` alone is not the
 * test: a page can be flagged `needsOcr` and still hold text worth keeping.
 */
function pageHasText(page: ExtractedPdfPage): boolean {
  return page.markdown.trim().length > 0;
}

function toExtractedPdfPage(page: {
  page: number;
  markdown: string;
  needsOcr: boolean;
  ocrReason?: string;
}): ExtractedPdfPage {
  return {
    // The one line the whole normalization rests on: the library counts from 0.
    pageNumber: page.page + 1,
    markdown: page.markdown,
    needsOcr: page.needsOcr,
    // `exactOptionalPropertyTypes` — an absent reason stays absent rather than
    // becoming a present `undefined`.
    ...(page.ocrReason === undefined ? {} : { ocrReason: page.ocrReason }),
  };
}

/**
 * Read a PDF's bytes. Returns exactly one `ExtractedPdf` variant for every
 * outcome that depends on those bytes. It throws only for the two
 * document-independent failures named in the module header: a native binary that
 * cannot load, and a vendor failure this module does not recognize.
 *
 * Two library calls. `classifyPdfAsync` (about 4.7 ms on a 100-page document)
 * supplies `pdfType` and the classifier page count;
 * `extractPagesMarkdownAsync` (about 51 ms) supplies the pages that decide the
 * variant. The extraction always runs, including for a document the classifier
 * calls `Scanned`: the classifier is a prediction, and paying 51 ms is cheaper
 * than discarding a readable page.
 */
export async function extractPdf(
  bytes: Uint8Array,
  options: ExtractPdfOptions,
): Promise<ExtractedPdf> {
  if (bytes.byteLength > options.maxBytes) {
    return { kind: "too_large", byteLength: bytes.byteLength, maxBytes: options.maxBytes };
  }

  const inspector = await loadInspector();
  // A view over the same memory, not a copy: both library calls copy the buffer
  // themselves before they return.
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  try {
    const classification = await inspector.classifyPdfAsync(buffer);
    const pdfType = toPdfDocumentType(classification.pdfType);
    const extraction = await inspector.extractPagesMarkdownAsync(buffer);
    const pages = extraction.pages.map(toExtractedPdfPage);

    // The verdict is the pages' own evidence, never `pdfType`. A document is
    // unreadable only when no page held text — one readable cover page in a
    // scan is still a readable page, and a `TextBased` document that yielded
    // nothing is still unreadable.
    if (!pages.some(pageHasText)) {
      return { kind: "needs_ocr", pdfType, pageCount: classification.pageCount };
    }

    return {
      kind: "extracted",
      pdfType,
      // From the pages, not from the classifier: two parses, and nothing holds
      // a second count equal to `pages.length`. Items downstream cite page
      // numbers, so an index that can run past the array is the defect class
      // this package exists to prevent.
      pageCount: pages.length,
      pages,
      // Derived from the normalized pages rather than read from the library's own
      // `pagesNeedingOcr`, so the document-level list and the per-page flags are
      // one fact in one index base instead of two facts that can disagree.
      pagesNeedingOcr: pages.filter((page) => page.needsOcr).map((page) => page.pageNumber),
    };
  } catch (error) {
    const failure = toExtractedPdfFailure(error);
    if (failure === undefined) throw error;
    return failure;
  }
}
