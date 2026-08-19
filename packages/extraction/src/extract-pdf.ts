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
//     optional-dependency install), which rejects with the library's own error;
//   * something that is not a vendor `GenericFailure` escapes — an
//     out-of-memory, a programming error, an unrelated host fault — which this
//     module wraps in `PdfExtractionError`.
//
// The document-level verdict comes from the PAGES, never from the library's
// `pdfType`. `pdfType` is a whole-document prediction with a text-density
// threshold behind it: an `ImageBased` scan with a born-digital cover page
// still holds readable text on that cover, and a `TextBased` document at
// confidence 1.00 can yield empty markdown on every page. Both are reproduced
// by tracked fixtures. So this module always runs the per-page extraction and
// reads the answer off the pages; `pdfType` is carried as metadata only.
//
// Two library surfaces read text, and they answer DIFFERENT questions, so this
// module asks both about every document:
//
//   * `extractPagesMarkdown` says which PAGE each piece of text sits on. It is
//     the only surface a citation may rest on, and it is the only one this
//     module lets a door quote a page number from.
//   * `extractText` reads the whole document at once and returns no page
//     boundary at all. It reads text the per-page surface returns as empty
//     markdown — the invisible OCR layer of a searchable scan, which is the
//     ordinary output of an office copier — so it is the only surface a
//     COMPLETENESS question may rest on.
//
// The rule this module holds, and the one every door inherits:
//
//   * `pages` are authoritative for CITATION. A door that quotes renders pages
//     and states their page numbers.
//   * `text` is authoritative for COMPLETENESS. Its presence is NOT evidence
//     that the pages failed, and its absence is NOT evidence that the pages are
//     complete.
//
// This module deliberately emits no coverage verdict, because it cannot compute
// one and the vendor emits no signal for it. It tried: it read `text` only when
// some page's markdown was empty, and page emptiness turned out not to be page
// coverage in either direction. A searchable scan whose pages carry a visible
// footer answers 28 characters of 1,408 with `needsOcr` false and
// `pagesNeedingOcr` empty, so no later layer can detect the loss; and one blank
// separator sheet inside a complete document made `text` present and invited a
// door to drop every page number it had. Both are tracked fixtures. A threshold
// that decided coverage here would be a guess, so both readings go to the door.
//
// Text with no page boundary rides beside the pages as `extracted.text`. When no
// page read at all it becomes `text_without_pages`, which asserts no page rather
// than attributing the whole document to page 1.

import type { PageMarkdownResult, PdfType } from "@firecrawl/pdf-inspector";

/** The library's `PdfType`, in this repo's casing. */
export type PdfDocumentType = "text_based" | "scanned" | "image_based" | "mixed";

/**
 * Why the parser rejected the bytes, as a CLOSED vocabulary of two. The vendor's
 * own message is open and stays in `reason`; this is the part a door may branch
 * on.
 *
 * `not_a_pdf` — these bytes were never a PDF at all, so a door reports what it
 * received and reads nothing. `damaged` — real PDF bytes the parser could not
 * finish, and every reading this module cannot make safely. `damaged` is the
 * wide, safe arm and authorizes no fallback of any kind.
 *
 * The two arms are deliberately coarse. An earlier version read the vendor's
 * sniffer detail and offered a third arm that told a door "these bytes are
 * readable text, so your plain-text path is allowed". The vendor sniffs the
 * FIRST BYTE, so it answered `"file appears to be JSON"` for a valid PDF whose
 * first byte is `{` or `[`, and `"file appears to be HTML"` for a valid PDF with
 * `<html>` prepended. A door acting on that arm would have rendered PDF source to
 * a model or a user. No arm here authorizes reading the bytes as text.
 *
 * `not_a_pdf` therefore rests on a deterministic reading of the bytes and not on
 * the vendor's guess alone: see `hasPdfMarkers`.
 */
export type InvalidPdfCause = "not_a_pdf" | "damaged";

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
      /**
       * THE CITATION ANCHOR. Every door that quotes this document renders these
       * pages and states these page numbers. `text` never replaces them.
       */
      readonly pages: readonly ExtractedPdfPage[];
      /** 1-indexed. Derived from `pages`, so it can never disagree with them. */
      readonly pagesNeedingOcr: readonly number[];
      /**
       * The whole document read as one string, with NO page boundary in it.
       * Always present, because the completeness question and the citation
       * question have different answers and this module refuses to guess which
       * one a door is asking. It is the only place the text of a searchable
       * scan's invisible OCR layer exists.
       *
       * It covers the WHOLE document, so it OVERLAPS `pages` rather than
       * extending them: a door reads one or the other and NEVER concatenates
       * the two. It is not the longer of the two either — on
       * `image-based-text-cover.pdf` the pages hold 26 characters and this holds
       * 23 — so "whichever is longer wins" is not a rule a door may use.
       *
       * Its presence is NOT evidence that the pages failed. Its emptiness is NOT
       * evidence that the pages are complete: `""` says only that this surface
       * read nothing.
       */
      readonly text: string;
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
  /**
   * The parser rejected the bytes. `cause` is this module's closed reading, so a
   * door branches on it instead of re-matching a substring this module already
   * matched; `reason` keeps the vendor's own words for a message to a human.
   */
  | { readonly kind: "invalid"; readonly cause: InvalidPdfCause; readonly reason: string }
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
 * The message substrings this module reads. Every one of them chooses BETWEEN
 * variants (or between causes) rather than deciding whether the caller gets a
 * value at all.
 *
 * Encryption is the single failure a door treats differently — it can ask for a
 * password — so it earns its own `kind`.
 *
 * The vendor's message vocabulary is open, so a table that decided totality
 * would be wrong the first time the vendor added a message. Tracked fixtures
 * assert every row a door acts on; a reword shows up as a red CI row instead of
 * Alfred telling a user their password-protected statement is a corrupt file.
 */
const ENCRYPTED_MESSAGE = "PDF is encrypted";

/**
 * The vendor's sniffer prefix — the whole of what this module reads from the
 * sniffer. The DETAIL behind it (`"file appears to be JSON"`, `"a PNG image"`,
 * `"plain text"`, and six more on the pinned version) is a guess drawn from the
 * first bytes, and it is deliberately ignored: measured on the pinned version,
 * the vendor answers `"file appears to be JSON"` for a valid PDF whose first byte
 * is `{`, and `"file appears to be plain text"` for a real PDF whose header moved
 * by one byte. A detail that answers for a real PDF can distinguish nothing, so
 * the prefix is read as one bit — "the sniffer rejected these bytes" — and
 * `hasPdfMarkers` decides whether to believe it.
 *
 * The detail still reaches a door whole, in `reason`, for a human to read.
 */
const NOT_A_PDF_PREFIX = "Not a PDF: ";

/**
 * The structures a PDF carries in its own bytes: the header, the cross-reference
 * pointer, and the end-of-file marker. Any one of them is enough.
 *
 * This is the deterministic half of the `not_a_pdf` verdict, and it OUTRANKS the
 * vendor's sniff. The vendor reads the first byte; this reads the file. So a valid
 * PDF with `<html>` prepended, or with byte 0 overwritten, keeps `damaged` — real
 * PDF structure that something broke — while genuine JSON, HTML, a PNG or a ZIP
 * carries none of these and earns `not_a_pdf`.
 *
 * A non-PDF that happens to contain one of these strings reads as `damaged`, which
 * is the safe direction: `damaged` authorizes nothing.
 */
const PDF_STRUCTURE_MARKERS = ["%PDF-", "startxref", "%%EOF"] as const;

/** `"<rust_fn_name>: "` — the prefix every library message carries. */
const RUST_FUNCTION_PREFIX = /^[a-z][a-z0-9_]*: /;

type PdfInspector = typeof import("@firecrawl/pdf-inspector");

/**
 * The error `extractPdf` throws when a vendor call fails for a reason that is
 * NOT a fact about the document. Every failure of the vendor's parser is a
 * variant of `ExtractedPdf`, so reaching this class means an out-of-memory, a
 * programming error, or an unrelated host fault escaped the library.
 *
 * The message names this package, the vendor and the vendor's `code`, so an
 * operator reading one line of a log can tell a broken installation from a
 * failure this module has never seen. `cause` carries the original error whole.
 *
 * The message is built here rather than with `toMessage` from
 * `@alfred/contracts`: this package's one dependency is the vendor, which is
 * what keeps `fetch_url` and the tool registry free of a `@alfred/db` edge.
 */
export class PdfExtractionError extends Error {
  constructor(cause: unknown) {
    super(
      `@alfred/extraction: @firecrawl/pdf-inspector failed with an error this package does not map` +
        ` (code: ${describeErrorCode(cause)}): ${describeErrorMessage(cause)}`,
      { cause },
    );
    this.name = "PdfExtractionError";
  }
}

/** The thrown value's `code`, read through an `in` narrowing rather than a cast. */
function describeErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) return String(error.code);
  return "none";
}

/**
 * The thrown value's message, for something that may not be an `Error` at all.
 *
 * `toMessage` from `@alfred/contracts` is the canonical helper for this, and it
 * is deliberately not used: this package's ONE dependency is the vendor, which
 * is what keeps `fetch_url` and the tool registry free of a `@alfred/db` edge.
 * Two lines are the cheaper side of that trade.
 */
function describeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error); // drift-ok: see above
}

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
 * An unrecognized message reads as `damaged`, which is the safe side: `damaged`
 * authorizes no fallback, so a door declines rather than feeding a user PDF
 * syntax.
 *
 * `undefined` survives for the other half: an error that is NOT a vendor failure
 * is a broken install, an out-of-memory, or a programming error, and reporting
 * one of those as "your PDF is corrupt" is the thing the rethrow prevents.
 */
function toExtractedPdfFailure(error: unknown, buffer: Buffer): ExtractedPdf | undefined {
  if (!isVendorFailure(error)) return undefined;
  const { message } = error;
  if (message.includes(ENCRYPTED_MESSAGE)) return { kind: "encrypted" };
  const reason = message.replace(RUST_FUNCTION_PREFIX, "");
  return { kind: "invalid", cause: toInvalidPdfCause(reason, buffer), reason };
}

/** Whether the bytes carry PDF structure of their own. */
function hasPdfMarkers(buffer: Buffer): boolean {
  return PDF_STRUCTURE_MARKERS.some((marker) => buffer.includes(marker));
}

/**
 * The closed cause a rejection means. Two arms, and the vendor decides neither of
 * them on its own.
 *
 * A structural fact gets a deterministic check: the bytes are read for PDF
 * structure first, and finding any of it settles the answer as `damaged` however
 * confidently the vendor's first-byte sniff named another format. Only bytes that
 * carry no PDF structure AND that the sniffer rejected earn `not_a_pdf`.
 *
 * Every other rejection — a truncated file, a broken cross-reference table, a
 * message this module has never seen — is `damaged`. That default is the design:
 * `damaged` authorizes no door fallback, so an unfamiliar vendor message costs a
 * door precision and never safety.
 */
function toInvalidPdfCause(reason: string, buffer: Buffer): InvalidPdfCause {
  if (hasPdfMarkers(buffer)) return "damaged";
  return reason.startsWith(NOT_A_PDF_PREFIX) ? "not_a_pdf" : "damaged";
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

/**
 * The whole document's text, or `undefined` when there is none to be had.
 *
 * This surface can only IMPROVE an answer the two parses already gave, so a
 * failure of it must never overturn one. A vendor parse failure here therefore
 * becomes `undefined`, and the document keeps the verdict its pages earned: a
 * tracked fixture — a three-byte edit of a born-digital document — parses to one
 * empty page and then fails here, and the true answer for it is `needs_ocr` with
 * one page, not `invalid` with none.
 *
 * A non-vendor error still escapes. That is the installation fault the module
 * header names, and it is not a fact about the document.
 *
 * `extractText` is the vendor's one synchronous entry point, so it holds the
 * event loop. Measured: 15.9 ms on a 500-page, 1,476,100-character document,
 * with 0.7 ms maximum event-loop lag, against about 51 ms for the per-page
 * extraction that already runs on every document.
 */
function readDocumentText(inspector: PdfInspector, buffer: Buffer): string | undefined {
  let text: string;
  try {
    text = inspector.extractText(buffer);
  } catch (error) {
    if (isVendorFailure(error)) return undefined;
    throw error;
  }
  return hasText(text) ? text : undefined;
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
 * Three library calls on every document, with no condition on any of them.
 * `classifyPdfAsync` (about 4.7 ms on a 100-page document) supplies `pdfType`;
 * `extractPagesMarkdownAsync` (about 51 ms) supplies the pages that decide the
 * variant and carry every page number; `extractText` (15.9 ms on a 500-page
 * document) supplies the whole document as one string. The per-page extraction
 * runs even for a document the classifier calls `Scanned`, because the
 * classifier is a prediction and paying 51 ms is cheaper than discarding a
 * readable page. `extractText` runs even for a document whose every page read,
 * because a page that reads a five-character footer is not a page that read the
 * document.
 */
export async function extractPdf(
  bytes: Uint8Array,
  options: ExtractPdfOptions,
): Promise<ExtractedPdf> {
  if (bytes.byteLength > options.maxBytes) {
    return { kind: "too_large", byteLength: bytes.byteLength, maxBytes: options.maxBytes };
  }

  const inspector = await loadInspector();
  // A view over the same memory, not a copy: all three library calls copy the
  // buffer themselves before they return.
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

    // Unconditional, and the module header says why: no test on the pages tells
    // this module whether the pages COVER the document, so it stops testing and
    // hands both readings to the door.
    const text = readDocumentText(inspector, buffer);

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
        // Always a string. `""` says this surface read nothing, which is a fact
        // about the surface and never a claim about the pages.
        text: text ?? "",
      };
    }

    // No page could be read. The third surface is the last word: a scan with an
    // invisible OCR text layer returns empty markdown per page and its whole
    // text there. It arrives with NO page boundary in it, so it gets a variant
    // that asserts no page rather than being attributed to page 1.
    if (text !== undefined) return { kind: "text_without_pages", pdfType, pageCount, text };

    return { kind: "needs_ocr", pdfType, pageCount };
  } catch (error) {
    const failure = toExtractedPdfFailure(error, buffer);
    if (failure === undefined) throw new PdfExtractionError(error);
    return failure;
  }
}
