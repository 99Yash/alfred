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
//   PY
//
// Deliberately NOT asserted: confidence scores, processing times, or the exact
// wording of `ocrReason`. Those are the vendor's self-report, not behavior a door
// depends on.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { extractPdf } from "../src/extract-pdf";

/** Larger than every fixture, so a test that is not about the cap never hits it. */
const NO_CAP = 10_000_000;

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
}

test("a born-digital PDF reports one page per page, numbered from 1", async () => {
  const result = await extractPdf(await fixture("born-digital-two-page.pdf"), {
    maxBytes: NO_CAP,
  });

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
  const result = await extractPdf(await fixture("scanned-single-page.pdf"), {
    maxBytes: NO_CAP,
  });

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
  const result = await extractPdf(await fixture("encrypted-aes128.pdf"), { maxBytes: NO_CAP });

  assert.equal(result.kind, "encrypted");
});

test("bytes that are not a PDF are `invalid`", async () => {
  const result = await extractPdf(await fixture("not-a-pdf.bin"), { maxBytes: NO_CAP });

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  // The reason is the vendor's, minus its `"<rust_fn>: "` prefix.
  assert.equal(result.reason, "Not a PDF: file appears to be plain text");
});

test("a truncated PDF is `invalid` too — a second vendor message, one kind", async () => {
  const result = await extractPdf(await fixture("truncated.pdf"), { maxBytes: NO_CAP });

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.equal(result.reason, "Invalid PDF structure");
});

test("bytes above the cap are `too_large`", async () => {
  const bytes = await fixture("born-digital-two-page.pdf");

  const result = await extractPdf(bytes, { maxBytes: 10 });

  assert.equal(result.kind, "too_large");
  if (result.kind !== "too_large") return;
  assert.equal(result.byteLength, bytes.byteLength);
  assert.equal(result.maxBytes, 10);
});

// The two documents below are the reason the variant is decided by the pages and
// not by the library's `pdfType`. Every other fixture is wholly text or wholly
// scanned, so none of them exercises the branch this module owns.

test("an `ImageBased` scan with a readable cover page is `extracted`, cover text and all", async () => {
  const result = await extractPdf(await fixture("image-based-text-cover.pdf"), {
    maxBytes: NO_CAP,
  });

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
});

// The two documents below are the reason the pages are not the last word either.
// Both return empty markdown on every page while the library's own `extractText`
// reads the whole document — so `needs_ocr` would throw away text Alfred has.

test("a PDF whose pages are all empty but whose text reads is `text_without_pages`", async () => {
  const result = await extractPdf(await fixture("invisible-text-two-page.pdf"), {
    maxBytes: NO_CAP,
  });

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
  const result = await extractPdf(await fixture("scanned-with-text-layer.pdf"), {
    maxBytes: NO_CAP,
  });

  assert.equal(result.kind, "text_without_pages");
  if (result.kind !== "text_without_pages") return;
  assert.equal(result.pageCount, 1);
  assert.match(result.text, /Alfred reads a PDF deterministically/);
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

  const result = await extractPdf(new Uint8Array(damaged), { maxBytes: NO_CAP });

  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  // The vendor's own reason survives, minus its `"<rust_fn>: "` prefix, so a door
  // can report what went wrong without this module having predicted the wording.
  assert.match(result.reason, /invalid file trailer/);
});
