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
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages.length, 2);

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

test("a scanned PDF is `needs_ocr` and asserts no page at all", async () => {
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

test("bytes above the cap are `too_large` and the library is never called", async () => {
  const bytes = await fixture("born-digital-two-page.pdf");

  const result = await extractPdf(bytes, { maxBytes: 10 });

  assert.equal(result.kind, "too_large");
  if (result.kind !== "too_large") return;
  assert.equal(result.byteLength, bytes.byteLength);
  assert.equal(result.maxBytes, 10);
});
