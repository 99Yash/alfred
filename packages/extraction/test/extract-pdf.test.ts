// Runs the real `@firecrawl/pdf-inspector` binary. A mock would test our belief about it.
//
// Rebuild the git-tracked fixtures with:
//
//   python3 -m venv /tmp/pv && /tmp/pv/bin/pip install pypdf reportlab pillow cryptography
//   # pypdf's `encrypt` needs `cryptography`.
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
//   # Vendor `pdfType` disagrees with the pages.
//   c3 = canvas.Canvas("image-based-text-cover.pdf", pagesize=LETTER)
//   c3.setFont("Helvetica", 14); c3.drawString(72, 700, "COVER PAGE MARKER delta"); c3.showPage()
//   for _ in range(3):
//       img2 = Image.new("RGB", (1224, 1584), "white")
//       ImageDraw.Draw(img2).text((100, 100), "SCANNED PAGE MARKER charlie", fill="black")
//       b2 = io.BytesIO(); img2.save(b2, format="PNG"); b2.seek(0)
//       c3.drawImage(ImageReader(b2), 0, 0, width=612, height=792); c3.showPage()
//   c3.save()
//
//   # Render mode 3 is invisible: TextBased, empty pages, but `extractText` reads it all.
//   LINE = "Alfred reads a PDF deterministically and reports a real page number."
//   c4 = canvas.Canvas("invisible-text-two-page.pdf", pagesize=LETTER)
//   for _ in range(2):
//       t = c4.beginText(72, 700); t.setFont("Helvetica", 12); t.setTextRenderMode(3)
//       for _ in range(10): t.textLine(LINE)
//       c4.drawText(t); c4.showPage()
//   c4.save()
//
//   # A page image over an invisible OCR layer, as a copier makes.
//   img3 = Image.new("RGB", (1224, 1584), "white")
//   ImageDraw.Draw(img3).text((100, 100), "SCANNED PAGE MARKER charlie", fill="black")
//   b3 = io.BytesIO(); img3.save(b3, format="PNG"); b3.seek(0)
//   c5 = canvas.Canvas("scanned-with-text-layer.pdf", pagesize=(612, 792))
//   c5.drawImage(ImageReader(b3), 0, 0, width=612, height=792)
//   t5 = c5.beginText(72, 700); t5.setFont("Helvetica", 12); t5.setTextRenderMode(3)
//   for _ in range(10): t5.textLine(LINE)
//   c5.drawText(t5); c5.showPage(); c5.save()
//
//   # Born-digital pages plus a searchable scan: page 3's text exists only at document level.
//   w2 = PdfWriter()
//   for src in ("born-digital-two-page.pdf", "scanned-with-text-layer.pdf"):
//       for p in PdfReader(src).pages: w2.add_page(p)
//   with open("mixed-searchable-scan.pdf", "wb") as f: w2.write(f)
//
//   # Seeded-search offsets: both parses succeed, only `extractText` throws. Keep them exact.
//   d = bytearray(open("born-digital-two-page.pdf", "rb").read())
//   for off, val in ((178, 107), (559, 221), (1121, 141)): d[off] = val
//   open("damaged-text-surface.pdf", "wb").write(bytes(d))
//
//   # A visible footer makes pages non-empty; the hidden layer holds most text.
//   # Keep 12pt: an 8pt footer reads as noise and the page comes back empty.
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
//   # A born-digital document with one blank separator sheet.
//   c7 = canvas.Canvas("blank-separator-page.pdf", pagesize=LETTER)
//   c7.setFont("Helvetica", 14); c7.drawString(72, 700, "PAGE ONE MARKER alpha"); c7.showPage()
//   c7.showPage()
//   c7.setFont("Helvetica", 14); c7.drawString(72, 700, "PAGE THREE MARKER charlie"); c7.showPage()
//   c7.save()
//   PY
//
// Not asserted: confidence, timings, `ocrReason` wording. They are vendor self-report.
// `PdfExtractionError` has no fixture: no document can produce one.
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
  assert.equal(result.pageCount, result.pages.length);

  // The library reports these pages as 0 and 1.
  assert.deepEqual(
    result.pages.map((page) => page.pageNumber),
    [1, 2],
  );

  // Each number names the page whose text it carries.
  assert.match(result.pages[0]?.markdown ?? "", /PAGE ONE MARKER alpha/);
  assert.match(result.pages[1]?.markdown ?? "", /PAGE TWO MARKER bravo/);

  assert.deepEqual(result.pagesNeedingOcr, []);
});

test("a scanned PDF with no text layer is `needs_ocr` and asserts no page at all", async () => {
  // Negative control for `text_without_pages`: same shape, but no text layer behind the image.
  const result = await extractPdf(await fixture("scanned-single-page.pdf"));

  assert.equal(result.kind, "needs_ocr");

  if (result.kind !== "needs_ocr") return;
  assert.equal(result.pdfType, "scanned");
  assert.equal(result.pageCount, 1);

  // Type-level check: nothing can cite a page of a document nobody read.
  // @ts-expect-error `needs_ocr` carries no `pages`.
  assert.equal(result.pages, undefined);
});

test("an encrypted PDF is `encrypted`, not `invalid`", async () => {
  // Catches a vendor message reword: every failure shares `code: "GenericFailure"`.
  const result = await extractPdf(await fixture("encrypted-aes128.pdf"));

  assert.equal(result.kind, "encrypted");
});

test("bytes that were never a PDF are `not_a_pdf`", async () => {
  const result = await extractPdf(await fixture("not-a-pdf.bin"));

  assert.equal(result.kind, "invalid");

  if (result.kind !== "invalid") return;
  // Needs both: a sniffer rejection AND no `%PDF-`, `startxref` or `%%EOF`.
  assert.equal(result.cause, "not_a_pdf");
  // The vendor reason minus its `"<rust_fn>: "` prefix. Nothing branches on it.
  assert.equal(result.reason, "Not a PDF: file appears to be plain text");
});

test("a real PDF whose first byte the sniffer reads as JSON is `damaged`", async () => {
  // The vendor sniffs only the first byte. `startxref` and `%%EOF` outrank the sniff.
  const damaged = Buffer.from(await fixture("born-digital-two-page.pdf"));
  damaged[0] = 0x7b; // `{`

  const result = await extractPdf(new Uint8Array(damaged));

  assert.equal(result.kind, "invalid");

  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "damaged");
  // Fails loudly if the vendor stops naming a text format here.
  assert.equal(result.reason, "Not a PDF: file appears to be JSON");
});

test("a real PDF behind an `<html>` prefix is `damaged`, not another format", async () => {
  // A proxy or error page prepends markup to a whole PDF.
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
  // Same reason as genuine text, so the reason alone cannot tell them apart.
  const damaged = Buffer.from(await fixture("born-digital-two-page.pdf"));
  damaged[0] = 0x00;

  const result = await extractPdf(new Uint8Array(damaged));

  assert.equal(result.kind, "invalid");

  if (result.kind !== "invalid") return;
  assert.equal(result.cause, "damaged");
  assert.equal(result.reason, "Not a PDF: file appears to be plain text");
});

test("a PNG wearing a PDF's name is `not_a_pdf`", async () => {
  // `not_a_pdf` authorizes no reading; it only says the bytes are another format.
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
  // A `.docx` is a ZIP container.
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
  // A real PDF gets the identical reason (see above), so no plain-text path is authorized.
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
  // `cause` tells "never a PDF" from "a PDF somebody broke".
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

  const result = await extractPdfCore(
    new Uint8Array([1]),
    { maxCharacters: 10 },
    async () => inspector,
  );

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

// The next two documents are why the pages, not the vendor `pdfType`, decide the variant.

test("an `ImageBased` scan with a readable cover page is `extracted`, cover text and all", async () => {
  const result = await extractPdf(await fixture("image-based-text-cover.pdf"));

  // The vendor says image-based, but one page has text.
  assert.equal(result.kind, "extracted");

  if (result.kind !== "extracted") return;
  assert.equal(result.pdfType, "image_based");
  assert.match(result.pages[0]?.markdown ?? "", /COVER PAGE MARKER delta/);

  // Scanned pages stay in `pages`, flagged.
  assert.deepEqual(result.pagesNeedingOcr, [2, 3, 4]);
  assert.equal(result.pageCount, result.pages.length);

  // `text` can be shorter than the pages, so "pick the longer string" is wrong.
  assert.equal(result.text.trim(), "COVER PAGE MARKER delta");
});

test("a cover page in front of a searchable scan keeps the scan's text", async () => {
  // Regression: the readable cover made the scan's OCR text drop out.
  const result = await extractPdf(await fixture("mixed-searchable-scan.pdf"));

  assert.equal(result.kind, "extracted");

  if (result.kind !== "extracted") return;
  assert.equal(result.pageCount, 3);

  assert.match(result.pages[0]?.markdown ?? "", /PAGE ONE MARKER alpha/);
  assert.match(result.pages[1]?.markdown ?? "", /PAGE TWO MARKER bravo/);
  assert.equal(result.pages[2]?.markdown.trim(), "");
  assert.deepEqual(result.pagesNeedingOcr, [3]);

  // The third page's text survives only at document level.
  assert.match(result.text, /Alfred reads a PDF deterministically/);
  // `text` covers the whole document, not the remainder.
  assert.match(result.text, /PAGE ONE MARKER alpha/);
});

test("a document whose every page reads still carries the document text", async () => {
  // `text` is unconditional, so its presence says nothing about page failure.
  const result = await extractPdf(await fixture("born-digital-two-page.pdf"));

  assert.equal(result.kind, "extracted");

  if (result.kind !== "extracted") return;
  assert.match(result.text, /PAGE ONE MARKER alpha/);
  assert.match(result.text, /PAGE TWO MARKER bravo/);
});

// The next two documents are why `text` is unconditional: page emptiness is not page coverage.

test("a searchable scan whose pages carry a footer still delivers its whole text", async () => {
  // A footer makes every page read, and `needsOcr` is false, so nothing else flags the loss.
  const result = await extractPdf(await fixture("stamped-searchable-scan.pdf"));

  assert.equal(result.kind, "extracted");

  if (result.kind !== "extracted") return;
  assert.deepEqual(result.pagesNeedingOcr, []);
  assert.deepEqual(
    result.pages.map((page) => page.markdown.trim()),
    ["## Page 1 of 2", "## Page 2 of 2"],
  );

  // The invisible OCR layer that no page reported.
  assert.match(result.text, /Alfred reads a PDF deterministically/);
  assert.ok(result.text.length > 1000, `the whole document, not ${result.text.length} characters`);
});

test("a blank separator page does not cost a complete document its page numbers", async () => {
  // The pages are the citation anchor, so a blank sheet must not drop them.
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

// The next two documents have empty pages but readable `extractText`, so `needs_ocr` is wrong.

test("a PDF whose pages are all empty but whose text reads is `text_without_pages`", async () => {
  const result = await extractPdf(await fixture("invisible-text-two-page.pdf"));

  assert.equal(result.kind, "text_without_pages");

  if (result.kind !== "text_without_pages") return;
  assert.equal(result.pdfType, "text_based");
  assert.equal(result.pageCount, 2);
  assert.match(result.text, /Alfred reads a PDF deterministically/);

  // Type-level check: text with no page boundary cannot cite a page.
  // @ts-expect-error `text_without_pages` carries no `pages`.
  assert.equal(result.pages, undefined);
});

test("a scanned page with an invisible OCR layer keeps its text", async () => {
  // Same page evidence as the `needs_ocr` fixture, but a text layer sits behind the image.
  const result = await extractPdf(await fixture("scanned-with-text-layer.pdf"));

  assert.equal(result.kind, "text_without_pages");

  if (result.kind !== "text_without_pages") return;
  assert.equal(result.pageCount, 1);
  assert.match(result.text, /Alfred reads a PDF deterministically/);
});

test("a failure of the third surface does not overturn a parse that succeeded", async () => {
  // Only `extractText` throws. That throw must not erase the page count the parses produced.
  const result = await extractPdf(await fixture("damaged-text-surface.pdf"));

  assert.equal(result.kind, "needs_ocr");

  if (result.kind !== "needs_ocr") return;
  assert.equal(result.pageCount, 1);
});

test("a PDF whose newlines were rewritten LF to CRLF is `invalid`, not a throw", async () => {
  // The vendor message set is open. An unknown message must still return a value.
  const original = await fixture("born-digital-two-page.pdf");

  const damaged = Buffer.from(
    Buffer.from(original).toString("latin1").replaceAll("\n", "\r\n"),
    "latin1",
  );

  const result = await extractPdf(new Uint8Array(damaged));

  assert.equal(result.kind, "invalid");

  if (result.kind !== "invalid") return;
  // Unknown messages read as `damaged`, the safe side for real PDF bytes.
  assert.equal(result.cause, "damaged");
  assert.match(result.reason, /invalid file trailer/);
});
