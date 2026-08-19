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
//      `code: "GenericFailure"` — one code for a bad password, a truncated
//      file, plain text renamed `.pdf`, and every parse error the parser can
//      raise. The message, shaped `"<rust_fn>: <reason>"`, is the only detail.
//      That mapping lives here, in one function, behind a pinned version.
//
// The rule that decides what is a returned value and what is a thrown error:
// a value describes an outcome that depends on the INPUT, a throw describes an
// outcome that depends on the INSTALLATION. So an encrypted, scanned, invalid or
// oversized document is a variant of `ExtractedPdf`.
//
// The failure mapping is therefore TOTAL over the vendor's own failures: any
// `Error` carrying `code: "GenericFailure"` is a fact about the bytes, so it
// becomes `encrypted` or `invalid` and never a throw. The vendor's message
// vocabulary is open — a PDF whose newlines were rewritten LF to CRLF by a
// text-mode copy fails with `"PDF parsing error: couldn't parse input: invalid
// file trailer"`, which no substring table written before it could match — so a
// substring table decides only WHICH variant, never whether the caller gets one.
//
// `extractPdf` therefore throws in exactly two cases, and a door must treat both
// as a dependency problem rather than a fact about the document:
//
//   * the native binary cannot load (no platform build, or a failed
//     optional-dependency install);
//   * something that is not a vendor `GenericFailure` escapes — an
//     out-of-memory, a programming error, an unrelated host fault.
//
// The document-level verdict comes from the PAGES, never from the library's
// `pdfType`. `pdfType` is a whole-document prediction with a text-density
// threshold behind it: an `ImageBased` scan with a born-digital cover page
// still holds readable text on that cover, and a `TextBased` document at
// confidence 1.00 can yield empty markdown on every page. Both are reproduced
// by tracked fixtures. So this module always runs the per-page extraction and
// reads the answer off the pages; `pdfType` is carried as metadata only.
//
// One vendor surface is still not enough to conclude a document holds no text.
// `extractPagesMarkdown` returns empty markdown for a scan carrying an invisible
// OCR text layer — the ordinary output of an office copier — while `extractText`
// on the same bytes returns that layer in full. So a document no page could read
// is asked a second question before it is called `needs_ocr`, and text that
// arrives with no page boundary is reported as `text_without_pages` rather than
// attributed to a page it did not come from.

import type { PageMarkdownResult, PdfType } from "@firecrawl/pdf-inspector";

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
   * The document holds text, but no surface of the library could say which page
   * any of it came from — a scan with an invisible OCR layer behind the image is
   * the everyday case. The text is worth reading, so it is here; it deliberately
   * carries NO `pages` array and no page number, because attributing it to page
   * 1 would be the exact fabrication this package exists to prevent.
   */
  | {
      readonly kind: "text_without_pages";
      /** Reported metadata, not a verdict. The verdict is `kind`. */
      readonly pdfType: PdfDocumentType;
      /** How many pages the document has. Which page holds which text is unknown. */
      readonly pageCount: number;
      /** The whole document's text, with no page boundary in it. */
      readonly text: string;
    }
  /**
   * No surface of the library read one character of this document, so there is
   * nothing to read without OCR. This is the only variant a model ever sees, and
   * it deliberately carries NO `pages` array — nothing downstream can assert a
   * page number for a document nobody read.
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
 * The one `code` every vendor failure carries. It names the SOURCE of the error,
 * not its cause: reaching this module means the parser rejected the bytes, which
 * is a fact about the document and therefore a variant rather than a throw.
 */
const VENDOR_FAILURE_CODE = "GenericFailure";

/**
 * The one message substring this module reads, and it chooses BETWEEN variants
 * rather than deciding whether the caller gets one. Encryption is the single
 * failure a door treats differently — it can ask for a password — so it is the
 * single substring worth pinning a version for. Everything else the parser
 * rejects is `invalid`, carrying the vendor's own reason.
 *
 * The vendor's message vocabulary is open, so a table that decided totality
 * would be wrong the first time the vendor added a message. A tracked fixture
 * asserts this row; a reword shows up as a red CI row instead of Alfred telling
 * a user their password-protected statement is a corrupt file.
 */
const ENCRYPTED_MESSAGE = "PDF is encrypted";

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
 * Whether an error came out of the vendor's parser. `code` is read through an
 * `in` narrowing rather than a cast, because the vendor's declarations type the
 * failure as a plain `Error` and the field is therefore `unknown` here.
 */
function isVendorFailure(error: unknown): error is Error {
  return error instanceof Error && "code" in error && error.code === VENDOR_FAILURE_CODE;
}

/**
 * The variant a library failure means, or `undefined` when the error did not
 * come from the vendor's parser at all.
 *
 * TOTAL over vendor failures, and that is the point: the vendor's messages are
 * an open vocabulary, so a table that had to recognize a message before the
 * caller got a value would turn an ordinary damaged document — a PDF copied in
 * text mode, one edited byte in the cross-reference table — into a throw. Every
 * `GenericFailure` is a fact about the bytes, so every one becomes a variant.
 *
 * `undefined` survives for the other half: an error that is NOT a vendor failure
 * is a broken install, an out-of-memory, or a programming error, and reporting
 * one of those as "your PDF is corrupt" is the thing this rethrow prevents.
 */
function toExtractedPdfFailure(error: unknown): ExtractedPdf | undefined {
  if (!isVendorFailure(error)) return undefined;
  const { message } = error;
  if (message.includes(ENCRYPTED_MESSAGE)) return { kind: "encrypted" };
  return { kind: "invalid", reason: message.replace(RUST_FUNCTION_PREFIX, "") };
}

/**
 * Text counts as read when it holds one non-whitespace character. The library
 * answers `""` for a page it could not read and `"\n"` for a whole document it
 * could not read, so the trim is what separates "nothing" from "almost nothing".
 */
function hasText(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * A page counts as read when its markdown holds text. `needsOcr` alone is not
 * the test: a page can be flagged `needsOcr` and still hold text worth keeping.
 */
function pageHasText(page: ExtractedPdfPage): boolean {
  return hasText(page.markdown);
}

/** The vendor's page, in this module's 1-indexed shape. */
function toExtractedPdfPage(page: PageMarkdownResult): ExtractedPdfPage {
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
 * outcome that depends on those bytes — every failure the vendor's parser
 * raises included. It throws only for the two document-independent failures
 * named in the module header: a native binary that cannot load, and an error
 * that did not come from the vendor's parser at all.
 *
 * Two library calls on every document, and a third only when the first two
 * found no text. `classifyPdfAsync` (about 4.7 ms on a 100-page document)
 * supplies `pdfType`; `extractPagesMarkdownAsync` (about 51 ms) supplies the
 * pages that decide the variant. The extraction always runs, including for a
 * document the classifier calls `Scanned`: the classifier is a prediction, and
 * paying 51 ms is cheaper than discarding a readable page. `extractText` runs
 * only on the no-page-text path — it is the vendor's one synchronous entry
 * point, so it holds the event loop, and it is asked only about a document that
 * would otherwise be reported as holding nothing at all.
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
    // ONE count, read once, before any branch. The classifier reports a second
    // page count from a second parse; the two agree today, and a number that is
    // only observed to agree is a number that can start disagreeing without a
    // test noticing. Items downstream cite page numbers, so an index that can
    // run past the array is the defect class this package exists to prevent.
    const pageCount = pages.length;

    // The verdict is the pages' own evidence, never `pdfType`. One readable
    // cover page in a scan is still a readable page, and a `TextBased` document
    // that yielded nothing on every page is still not `extracted`.
    if (pages.some(pageHasText)) {
      return {
        kind: "extracted",
        pdfType,
        pageCount,
        pages,
        // Derived from the normalized pages rather than read from the library's own
        // `pagesNeedingOcr`, so the document-level list and the per-page flags are
        // one fact in one index base instead of two facts that can disagree.
        pagesNeedingOcr: pages.filter((page) => page.needsOcr).map((page) => page.pageNumber),
      };
    }

    // No page could be read. Before this document is called unreadable, ask the
    // one vendor surface that answers about the whole document: a scan with an
    // invisible OCR text layer returns empty markdown per page and its whole
    // text here. That text arrives with NO page boundary in it, so it gets a
    // variant that asserts no page rather than being attributed to page 1.
    const text = inspector.extractText(buffer);
    if (hasText(text)) return { kind: "text_without_pages", pdfType, pageCount, text };

    return { kind: "needs_ocr", pdfType, pageCount };
  } catch (error) {
    const failure = toExtractedPdfFailure(error);
    if (failure === undefined) throw error;
    return failure;
  }
}
