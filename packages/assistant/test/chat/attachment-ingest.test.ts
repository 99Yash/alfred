import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  consumePendingPdfDegradedText,
  extractChatPdfText,
  rememberPendingPdfDegradedText,
} from "@alfred/assistant/chat/attachment-ingest";

async function pdfFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(new URL(`../../../extraction/test/fixtures/${name}`, import.meta.url)),
  );
}

describe("chat PDF ingest", () => {
  test("extracts proven page markers and consumes the upload-time handoff once", async () => {
    const storageKey = "chat/u1/t1/m1/att-pdf-happy-path-report.pdf";
    const degradedText = await extractChatPdfText(await pdfFixture("born-digital-two-page.pdf"));

    assert.ok(degradedText);
    assert.match(degradedText, /\[page 1\]\n.*PAGE ONE MARKER alpha/s);
    assert.match(degradedText, /\[page 2\]\n.*PAGE TWO MARKER bravo/s);

    rememberPendingPdfDegradedText(storageKey, degradedText);
    assert.equal(consumePendingPdfDegradedText(storageKey), degradedText);
    assert.equal(consumePendingPdfDegradedText(storageKey), undefined);
  });
});
