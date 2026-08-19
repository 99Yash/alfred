// `extractPdf` against the REAL native binary — no mock of
// `@firecrawl/pdf-inspector`. Every fact this wrapper encodes (the page index
// base, the failure messages) is a fact about that binary, so a mock would
// assert our belief about the library rather than the library.
//
// The fixtures are tiny, deterministic and git-tracked. Rebuild them with:
//
//   python3 -m venv /tmp/pv && /tmp/pv/bin/pip install pypdf reportlab pillow cryptography
//   # `cryptography` is required, or pypdf's `encrypt` raises DependencyError.
//   cd packages/extraction/test/fixtures && /tmp/pv/bin/python - <<'PY'
//   from reportlab.pdfgen import canvas
//   from reportlab.lib.pagesizes import LETTER
//   from reportlab.lib.utils import ImageReader
//   from PIL import Image, ImageDraw
//   from pypdf import PdfReader, PdfWriter
//   import io
//
//   c = canvas.Canvas("born-digital-two-page.pdf", pagesize=LETTER)
//   c.setFont("Helvetica", 14); c.drawString(72, 700, "PAGE ONE MARKER alpha"); c.showPage()
//   c.setFont("Helvetica", 14); c.drawString(72, 700, "PAGE TWO MARKER bravo"); c.showPage()
//   c.save()
//
//   img = Image.new("RGB", (1224, 1584), "white")
//   ImageDraw.Draw(img).text((100, 100), "SCANNED PAGE MARKER charlie", fill="black")
//   buf = io.BytesIO(); img.save(buf, format="PNG"); buf.seek(0)
//   c2 = canvas.Canvas("scanned-single-page.pdf", pagesize=(612, 792))
//   c2.drawImage(ImageReader(buf), 0, 0, width=612, height=792); c2.showPage(); c2.save()
//
//   r = PdfReader("born-digital-two-page.pdf"); w = PdfWriter()
//   for p in r.pages: w.add_page(p)
//   w.encrypt("secret", algorithm="AES-128")
//   with open("encrypted-aes128.pdf", "wb") as f: w.write(f)
//
//   open("not-a-pdf.bin", "wb").write(b"this is not a pdf at all\x00\x01\x02" * 20)
//   data = open("born-digital-two-page.pdf", "rb").read()
//   open("truncated.pdf", "wb").write(data[: len(data) // 3])
//
//   # The two documents where the vendor's `pdfType` disagrees with the pages.
//   c3 = canvas.Canvas("image-based-text-cover.pdf", pagesize=LETTER)
//   c3.setFont("Helvetica", 14); c3.drawString(72, 700, "COVER PAGE MARKER delta"); c3.showPage()
//   for _ in range(3):
//       img2 = Image.new("RGB", (1224, 1584), "white")
//       ImageDraw.Draw(img2).text((100, 100), "SCANNED PAGE MARKER charlie", fill="black")
//       b2 = io.BytesIO(); img2.save(b2, format="PNG"); b2.seek(0)
//       c3.drawImage(ImageReader(b2), 0, 0, width=612, height=792); c3.showPage()
//   c3.save()
//
//   # Text render mode 3 is invisible: the classifier still calls it TextBased at
//   # confidence 1.00, and the per-page extraction returns nothing — while
//   # `extractText` returns every character.
//   LINE = "Alfred reads a PDF deterministically and reports a real page number."
//   c4 = canvas.Canvas("invisible-text-two-page.pdf", pagesize=LETTER)
//   for _ in range(2):
//       t = c4.beginText(72, 700); t.setFont("Helvetica", 12); t.setTextRenderMode(3)
//       for _ in range(10): t.textLine(LINE)
//       c4.drawText(t); c4.showPage()
//   c4.save()
//
//   # The everyday searchable scan: a page image with an invisible OCR text layer
//   # behind it, which is what an office copier produces.
//   img3 = Image.new("RGB", (1224, 1584), "white")
//   ImageDraw.Draw(img3).text((100, 100), "SCANNED PAGE MARKER charlie", fill="black")
//   b3 = io.BytesIO(); img3.save(b3, format="PNG"); b3.seek(0)
//   c5 = canvas.Canvas("scanned-with-text-layer.pdf", pagesize=(612, 792))
//   c5.drawImage(ImageReader(b3), 0, 0, width=612, height=792)
//   t5 = c5.beginText(72, 700); t5.setFont("Helvetica", 12); t5.setTextRenderMode(3)
//   for _ in range(10): t5.textLine(LINE)
//   c5.drawText(t5); c5.showPage(); c5.save()
//
//   # The everyday mixed document: a born-digital cover in front of a searchable
//   # scan. Per-page markdown is [24, 24, 0] and `extractText` holds 736
//   # characters, so the third page's text exists ONLY at document level.
//   w2 = PdfWriter()
//   for src in ("born-digital-two-page.pdf", "scanned-with-text-layer.pdf"):
//       for p in PdfReader(src).pages: w2.add_page(p)
//   with open("mixed-searchable-scan.pdf", "wb") as f: w2.write(f)
//
//   # Three edited bytes, found by a seeded search over 4000 mutations: the two
//   # parses still succeed and `extractText` alone throws. The offsets are the
//   # fixture, not a rule about PDFs — regenerate only from this exact recipe.
//   d = bytearray(open("born-digital-two-page.pdf", "rb").read())
//   for off, val in ((178, 107), (559, 221), (1121, 141)): d[off] = val
//   open("damaged-text-surface.pdf", "wb").write(bytes(d))
//
//   # Round 4's two documents, one for each direction of the rule that page
//   # EMPTINESS is not page COVERAGE. A searchable scan whose every page also
//   # carries a VISIBLE footer: the footer alone makes per-page markdown
//   # non-empty (28 characters) while the invisible layer behind the image holds
//   # 1,408. The font size is load-bearing — an 8pt footer reads as noise and the
//   # page comes back empty, which is a different fixture.
//   c6 = canvas.Canvas("stamped-searchable-scan.pdf", pagesize=(612, 792))
//   for n in (1, 2):
//       img4 = Image.new("RGB", (1224, 1584), "white")
//       ImageDraw.Draw(img4).text((100, 100), "SCANNED PAGE MARKER charlie", fill="black")
//       b4 = io.BytesIO(); img4.save(b4, format="PNG"); b4.seek(0)
//       c6.drawImage(ImageReader(b4), 0, 0, width=612, height=792)
//       t6 = c6.beginText(72, 700); t6.setFont("Helvetica", 12); t6.setTextRenderMode(3)
//       for _ in range(10): t6.textLine(LINE)
//       c6.drawText(t6)
//       c6.setFont("Helvetica", 12); c6.drawString(72, 36, "Page %d of 2" % n)
//       c6.showPage()
//   c6.save()
//
//   # A complete born-digital document with one BLANK separator sheet in it.
//   c7 = canvas.Canvas("blank-separator-page.pdf", pagesize=LETTER)
//   c7.setFont("Helvetica", 14); c7.drawString(72, 700, "PAGE ONE MARKER alpha"); c7.showPage()
//   c7.showPage()
//   c7.setFont("Helvetica", 14); c7.drawString(72, 700, "PAGE THREE MARKER charlie"); c7.showPage()
//   c7.save()
//   PY
//
// Deliberately NOT asserted: confidence scores, processing times, or the exact
// wording of `ocrReason`. Those are the vendor's self-report, not behavior a door
// depends on. `PdfExtractionError` has no fixture either — it needs a non-vendor
// error out of the library, and no document can produce one.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createPdfExtractor } from "../src/extract-pdf";
import { extractPdfCore } from "../src/extract-pdf-core";

/** Larger than every fixture, so a test that is not about the cap never hits it. */
const NO_CAP = 10_000_000;
const extractPdf = createPdfExtractor({
  maxBytes: NO_CAP,
  maxCharacters: NO_CAP,
  maxParseMilliseconds: 30_000,
});

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
}

test("a born-digital PDF reports one page per page, numbered from 1", async () => {
  const result = await extractPdf(await fixture("born-digital-two-page.pdf"));

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.pdfType, "text_based");
  assert.equal(result.pages.length, 2);
  // `pageCount` is `pages.length`, so `pages[pageCount - 1]` always exists.
  assert.equal(result.pageCount, result.pages.length);

  // The whole normalization, in two assertions: the library reports these pages
  // as 0 and 1.
  assert.deepEqual(
    result.pages.map((page) => page.pageNumber),
    [1, 2],
  );

  // …and the numbering is not merely ascending — each number names the page whose
  // text it carries.
  assert.match(result.pages[0]?.markdown ?? "", /PAGE ONE MARKER alpha/);
  assert.match(result.pages[1]?.markdown ?? "", /PAGE TWO MARKER bravo/);

  assert.deepEqual(result.pagesNeedingOcr, []);
});

test("a scanned PDF with no text layer is `needs_ocr` and asserts no page at all", async () => {
  // The negative control for `text_without_pages` below: same shape of document —
  // one page image, empty markdown, `needsOcr` — but no text layer behind it, so
  // no vendor surface reads a character and `needs_ocr` is the true answer.
  const result = await extractPdf(await fixture("scanned-single-page.pdf"));

  assert.equal(result.kind, "needs_ocr");
  if (result.kind !== "needs_ocr") return;
  assert.equal(result.pdfType, "scanned");
  assert.equal(result.pageCount, 1);

  // Tier 1, checked by `tsconfig.test.json` rather than at runtime: the variant a
  // model sees has no `pages` field, so nothing downstream can cite a page of a
  // document nobody read.
  // @ts-expect-error `needs_ocr` carries no `pages`.
  assert.equal(result.pages, undefined);
});

test("an encrypted PDF is `encrypted`, not `invalid`", async () => {
  // This is the test that catches a vendor message reword: every library failure
  // shares `code: "GenericFailure"`, so the message is the only discriminator.
  const result = await extractPdf(await fixture("encrypted-aes128.pdf"));

  assert.equal(result.kind, "encrypted");
});

test("bytes that were never a PDF are `not_a_pdf`", async () => {
  const result = await extractPdf(await fixture("not-a-pdf.bin"));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  // The sniffer rejected these bytes AND they carry no `%PDF-`, `startxref` or
  // `%%EOF` of their own. Both halves are needed: the tests below feed the
  // sniffer a real PDF and get the same rejection back.
  assert.equal(result.cause, "not_a_pdf");
  // The reason is the vendor's, minus its `"<rust_fn>: "` prefix, so a door can
  // still tell a human what the vendor thought. Nothing branches on it.
  assert.equal(result.reason, "Not a PDF: file appears to be plain text");
});

test("a real PDF whose first byte the sniffer reads as JSON is `damaged`", async () => {
  // The counterexample that collapsed `cause` to two arms. The vendor sniffs the
  // FIRST BYTE, so one edited byte makes it name an exact text format — and a
  // door that trusted the name would render PDF source to a user. The bytes still
  // hold `startxref` and `%%EOF`, and that structural fact outranks the sniff.
  const damaged = Buffer.from(await fixture("born-digital-two-page.pdf"));
  damaged[0] = 0x7b; // `{`

  const result = await extractPdf(new Uint8Array(damaged));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "damaged");
  // Asserted so the day the vendor stops naming a text format here is a red row
  // and not a silent widening of what `not_a_pdf` covers.
  assert.equal(result.reason, "Not a PDF: file appears to be JSON");
});

test("a real PDF behind an `<html>` prefix is `damaged`, not another format", async () => {
  // The second counterexample, and the everyday one: a proxy or an error page
  // that prepends markup to bytes that are still a whole PDF. The sniffer sees
  // the prefix; `%PDF-` is three bytes further in.
  const prefixed = Buffer.concat([
    Buffer.from("<html>\n"),
    Buffer.from(await fixture("born-digital-two-page.pdf")),
  ]);

  const result = await extractPdf(new Uint8Array(prefixed));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "damaged");
  assert.equal(result.reason, "Not a PDF: file appears to be HTML");
});

test("a real PDF with one damaged header byte is `damaged` too", async () => {
  // The same structural gate against the vendor's other guess: the detail here is
  // `"plain text"`, the same one genuine text gets, which is why no detail this
  // module reads can tell the two apart.
  const damaged = Buffer.from(await fixture("born-digital-two-page.pdf"));
  damaged[0] = 0x00;

  const result = await extractPdf(new Uint8Array(damaged));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "damaged");
  assert.equal(result.reason, "Not a PDF: file appears to be plain text");
});

test("a PNG wearing a PDF's name is `not_a_pdf`", async () => {
  // Eight magic bytes, so no fixture file earns its keep. A door reports what it
  // received and reads nothing — `not_a_pdf` authorizes no reading either, it
  // only tells a door the bytes are somebody else's format.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(200, 7),
  ]);

  const result = await extractPdf(new Uint8Array(png));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "not_a_pdf");
  assert.equal(result.reason, "Not a PDF: file appears to be a PNG image");
});

test("a JPEG wearing a PDF's name is `not_a_pdf`", async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

  const result = await extractPdf(new Uint8Array(jpeg));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "not_a_pdf");
  assert.equal(result.reason, "Not a PDF: file appears to be a JPEG image");
});

test("an Office document wearing a PDF's name is `not_a_pdf`", async () => {
  // A `.docx` renamed `.pdf` is a ZIP container, and the everyday mail-attachment
  // case: the sender meant to send a PDF and did not.
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]);

  const result = await extractPdf(new Uint8Array(zip));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "not_a_pdf");
  assert.equal(
    result.reason,
    "Not a PDF: file appears to be a ZIP archive (possibly an Office document)",
  );
});

test("HTML wearing a PDF's name is `not_a_pdf` — no arm authorizes reading it", async () => {
  // The everyday `fetch_url` case: a URL answers with an error page or a login
  // wall under a PDF content type. The vendor names an exact text format, and this
  // module still refuses to authorize a plain-text path — because the identical
  // detail arrives for a real PDF, two tests above.
  const html = Buffer.from("<html><body><p>hello</p></body></html>\n".repeat(5));

  const result = await extractPdf(new Uint8Array(html));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "not_a_pdf");
  assert.equal(result.reason, "Not a PDF: file appears to be HTML");
});

test("JSON wearing a PDF's name is `not_a_pdf`", async () => {
  const json = Buffer.from(`${JSON.stringify({ error: "not found" })}\n`);

  const result = await extractPdf(new Uint8Array(json));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "not_a_pdf");
  assert.equal(result.reason, "Not a PDF: file appears to be JSON");
});

test("a truncated PDF is `invalid` too — a second vendor message, one kind", async () => {
  const result = await extractPdf(await fixture("truncated.pdf"));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  // Real PDF bytes the parser could not finish, and the vendor does not reach its
  // sniffer at all here — a third message shape, still one `kind`. Same `cause` as
  // the two mutated documents above and a different one from the JSON, which is
  // the whole point of the field: a door tells "never a PDF" from "a PDF somebody
  // broke" without matching a substring this module already matched.
  assert.equal(result.cause, "damaged");
  assert.equal(result.reason, "Invalid PDF structure");
});

test("bytes above the cap use the shared limit result", async () => {
  const bytes = await fixture("born-digital-two-page.pdf");

  const result = await createPdfExtractor({
    maxBytes: 10,
    maxCharacters: NO_CAP,
    maxParseMilliseconds: 30_000,
  })(bytes);

  assert.equal(result.kind, "limit_exceeded");
  if (result.kind !== "limit_exceeded") return;
  assert.equal(result.limit, "input_bytes");
  assert.equal(result.actual, bytes.byteLength);
  assert.equal(result.maximum, 10);
});

test("page markdown above the character cap returns no partial content", async () => {
  const result = await createPdfExtractor({
    maxBytes: NO_CAP,
    maxCharacters: 10,
    maxParseMilliseconds: 30_000,
  })(await fixture("born-digital-two-page.pdf"));

  assert.equal(result.kind, "limit_exceeded");
  if (result.kind !== "limit_exceeded") return;
  assert.equal(result.limit, "output_characters");
  assert.ok(result.actual > 10);
  assert.equal(result.maximum, 10);
  assert.equal("pages" in result, false);
  assert.equal("text" in result, false);
});

test("a page-only character breach skips the synchronous document read", async () => {
  let documentReadCalled = false;
  const inspector = {
    classifyPdfAsync: async (_buffer: Buffer) => ({ pdfType: "TextBased" as const }),
    extractPagesMarkdownAsync: async (_buffer: Buffer) => ({
      pages: [{ page: 0, markdown: "eleven chars", needsOcr: false }],
    }),
    extractText: (_buffer: Buffer) => {
      documentReadCalled = true;
      return "must not be read";
    },
  };

  const result = await extractPdfCore(new Uint8Array([1]), 10, async () => inspector);

  assert.equal(result.kind, "limit_exceeded");
  if (result.kind !== "limit_exceeded") return;
  assert.equal(result.limit, "output_characters");
  assert.equal(result.actual, 12);
  assert.equal(documentReadCalled, false);
});

test("the character cap counts overlapping page and document readings", async () => {
  const bytes = await fixture("born-digital-two-page.pdf");
  const unbounded = await extractPdf(bytes);
  assert.equal(unbounded.kind, "extracted");
  if (unbounded.kind !== "extracted") return;
  const pageCharacters = unbounded.pages.reduce((total, page) => total + page.markdown.length, 0);

  const result = await createPdfExtractor({
    maxBytes: NO_CAP,
    maxCharacters: pageCharacters,
    maxParseMilliseconds: 30_000,
  })(bytes);

  assert.equal(result.kind, "limit_exceeded");
  if (result.kind !== "limit_exceeded") return;
  assert.equal(result.limit, "output_characters");
  assert.equal(result.actual, pageCharacters + unbounded.text.length);
  assert.equal(result.maximum, pageCharacters);
  assert.equal("pages" in result, false);
  assert.equal("text" in result, false);
});

// The two documents below are the reason the variant is decided by the pages and
// not by the library's `pdfType`. Every other fixture is wholly text or wholly
// scanned, so none of them exercises the branch this module owns.

test("an `ImageBased` scan with a readable cover page is `extracted`, cover text and all", async () => {
  const result = await extractPdf(await fixture("image-based-text-cover.pdf"));

  // The vendor calls the whole document image-based. One page disagrees, and a
  // door must still get that page's text.
  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.pdfType, "image_based");
  assert.match(result.pages[0]?.markdown ?? "", /COVER PAGE MARKER delta/);

  // The scanned pages stay in `pages`, flagged, rather than vanishing: the
  // document-level verdict and the page-level flag are different facts.
  assert.deepEqual(result.pagesNeedingOcr, [2, 3, 4]);
  assert.equal(result.pageCount, result.pages.length);

  // The document reading holds 23 characters against the pages' 26. That is the
  // measurement behind the docstring: `text` is not a longer answer, and a door
  // that picked whichever string is longer would pick wrongly on this very
  // document.
  assert.equal(result.text.trim(), "COVER PAGE MARKER delta");
});

test("a cover page in front of a searchable scan keeps the scan's text", async () => {
  // The defect this fixture exists for: the cover page reads, so a document-level
  // test calls the whole document `extracted` and stops. The scanned page behind
  // it carries an invisible OCR layer that only `extractText` reads, and its text
  // would be dropped — 50 characters of 739 reaching the door.
  const result = await extractPdf(await fixture("mixed-searchable-scan.pdf"));

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.pageCount, 3);

  // The two born-digital pages keep their own page numbers, as always.
  assert.match(result.pages[0]?.markdown ?? "", /PAGE ONE MARKER alpha/);
  assert.match(result.pages[1]?.markdown ?? "", /PAGE TWO MARKER bravo/);
  assert.equal(result.pages[2]?.markdown.trim(), "");
  assert.deepEqual(result.pagesNeedingOcr, [3]);

  // …and the third page's text survives at document level, where it is true: the
  // vendor said which page the first two came from and never said it for this.
  assert.match(result.text, /Alfred reads a PDF deterministically/);
  // `text` covers the WHOLE document, pages included. It overlaps `pages`; it is
  // not the remainder.
  assert.match(result.text, /PAGE ONE MARKER alpha/);
});

test("a document whose every page reads still carries the document text", async () => {
  // `text` is unconditional. Nothing about these two pages is wrong, and the
  // document reading arrives anyway — so its presence says nothing about
  // whether the pages failed.
  const result = await extractPdf(await fixture("born-digital-two-page.pdf"));

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.match(result.text, /PAGE ONE MARKER alpha/);
  assert.match(result.text, /PAGE TWO MARKER bravo/);
});

// The two documents below are the reason `text` is unconditional. Page EMPTINESS
// was the condition until round 4 of this item's review, and page emptiness is
// not page coverage: it is wrong in both directions, and each direction has a
// fixture here.

test("a searchable scan whose pages carry a footer still delivers its whole text", async () => {
  // Every page reads — a visible `Page 1 of 2` footer is enough — so an "every
  // page read" condition skips the document surface and hands the door 28
  // characters of 1,408. The vendor reports nothing: `needsOcr` is false on
  // every page, so no later layer could detect the loss.
  const result = await extractPdf(await fixture("stamped-searchable-scan.pdf"));

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.deepEqual(result.pagesNeedingOcr, []);
  assert.deepEqual(
    result.pages.map((page) => page.markdown.trim()),
    ["## Page 1 of 2", "## Page 2 of 2"],
  );

  // The scan's invisible OCR layer, which no page reported and which is most of
  // the document.
  assert.match(result.text, /Alfred reads a PDF deterministically/);
  assert.ok(result.text.length > 1000, `the whole document, not ${result.text.length} characters`);
});

test("a blank separator page does not cost a complete document its page numbers", async () => {
  // The other direction. One blank sheet made the old condition true and
  // attached `text` to a document whose pages were complete; a door that read
  // `text` first — as the README exemplar once told it to — then dropped every
  // page number. The pages are the citation anchor, so they come first now.
  const result = await extractPdf(await fixture("blank-separator-page.pdf"));

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.deepEqual(
    result.pages.map((page) => page.pageNumber),
    [1, 2, 3],
  );
  assert.match(result.pages[0]?.markdown ?? "", /PAGE ONE MARKER alpha/);
  assert.equal(result.pages[1]?.markdown.trim(), "");
  assert.match(result.pages[2]?.markdown ?? "", /PAGE THREE MARKER charlie/);
});

// The two documents below are the reason the pages are not the last word either.
// Both return empty markdown on every page while the library's own `extractText`
// reads the whole document — so `needs_ocr` would throw away text Alfred has.

test("a PDF whose pages are all empty but whose text reads is `text_without_pages`", async () => {
  const result = await extractPdf(await fixture("invisible-text-two-page.pdf"));

  // The classifier reports `TextBased` at confidence 1.00 for these bytes and
  // every page comes back empty, so `extracted` would promise pages this module
  // cannot fill. `extractText` reads the text, without saying which page it is
  // on — which is exactly what this variant claims.
  assert.equal(result.kind, "text_without_pages");
  if (result.kind !== "text_without_pages") return;
  assert.equal(result.pdfType, "text_based");
  assert.equal(result.pageCount, 2);
  assert.match(result.text, /Alfred reads a PDF deterministically/);

  // Tier 1, checked by `tsconfig.test.json` rather than at runtime: the text
  // arrived with no page boundary, so no door can cite a page for it.
  // @ts-expect-error `text_without_pages` carries no `pages`.
  assert.equal(result.pages, undefined);
});

test("a scanned page with an invisible OCR layer keeps its text", async () => {
  // The everyday searchable scan. The page is an image, its markdown is empty and
  // `needsOcr` is set — the same evidence the `needs_ocr` fixture shows — but a
  // text layer sits behind the image and it is the document's whole content.
  const result = await extractPdf(await fixture("scanned-with-text-layer.pdf"));

  assert.equal(result.kind, "text_without_pages");
  if (result.kind !== "text_without_pages") return;
  assert.equal(result.pageCount, 1);
  assert.match(result.text, /Alfred reads a PDF deterministically/);
});

test("a failure of the third surface does not overturn a parse that succeeded", async () => {
  // Three edited bytes: both parses still succeed and return one empty page, and
  // `extractText` alone throws `extract_text: PDF parsing error: dictionary has
  // wrong type: `. That throw is asked to IMPROVE `needs_ocr`, so it must not be
  // able to delete the page structure the parses already produced. Sharing one
  // `try` with them would report `invalid` and no page count at all.
  const result = await extractPdf(await fixture("damaged-text-surface.pdf"));

  assert.equal(result.kind, "needs_ocr");
  if (result.kind !== "needs_ocr") return;
  assert.equal(result.pageCount, 1);
});

test("a PDF whose newlines were rewritten LF to CRLF is `invalid`, not a throw", async () => {
  // The vendor's message vocabulary is open. These bytes fail with `"PDF parsing
  // error: couldn't parse input: invalid file trailer"` — a message no substring
  // table written before it could hold — and a text-mode copy of a real document
  // is an ordinary accident, not a broken install. So the caller gets a value.
  const original = await fixture("born-digital-two-page.pdf");
  const damaged = Buffer.from(
    Buffer.from(original).toString("latin1").replaceAll("\n", "\r\n"),
    "latin1",
  );

  const result = await extractPdf(new Uint8Array(damaged));

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  // An unrecognized message reads as `damaged`, which is the safe side: these
  // ARE PDF bytes, so a door must not offer them to its plain-text path.
  assert.equal(result.cause, "damaged");
  // The vendor's own reason survives, minus its `"<rust_fn>: "` prefix, so a door
  // can report what went wrong without this module having predicted the wording.
  assert.match(result.reason, /invalid file trailer/);
});
