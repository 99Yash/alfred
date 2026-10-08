import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EMAIL_CSP_META, sanitizeEmailHtml } from "@alfred/assistant/triage/email-html";

/**
 * The email body leads `<head>` with a strict CSP meta, so opening it loads no tracking pixel (#294).
 * DOMPurify strips `<meta>`, so the sanitizer re-adds it.
 */
describe("sanitizeEmailHtml CSP (#294)", () => {
  test("injects the strict CSP meta first in <head>, before <base>", () => {
    const out = sanitizeEmailHtml(
      "<html><head><title>Receipt</title></head><body><p>Hi</p></body></html>",
    );

    assert.ok(out);
    assert.ok(out.includes(EMAIL_CSP_META), "the exact CSP meta is present");
    const cspIdx = out.indexOf('http-equiv="Content-Security-Policy"');
    const baseIdx = out.indexOf('<base target="_blank">');
    assert.ok(cspIdx >= 0 && baseIdx >= 0);
    assert.ok(cspIdx < baseIdx, "CSP meta comes before <base> so it governs the document");
  });

  test("default policy blocks remote img/media but allows data: + cid: images", () => {
    assert.match(EMAIL_CSP_META, /default-src 'none'/);
    assert.match(EMAIL_CSP_META, /img-src data: cid:/);
    assert.match(EMAIL_CSP_META, /media-src 'none'/);
    assert.match(EMAIL_CSP_META, /script-src 'none'/);
    // Remote images in img-src only after the user opts in.
    assert.doesNotMatch(EMAIL_CSP_META, /img-src[^;]*https?:/);
  });

  test("wraps a bare-fragment body in a document with the CSP meta", () => {
    const out = sanitizeEmailHtml("<p>just a fragment</p>");
    assert.ok(out);
    assert.ok(out.includes(EMAIL_CSP_META));
    assert.match(out, /just a fragment/);
  });

  test("strips a sender-supplied permissive CSP meta and bakes our strict one", () => {
    const out = sanitizeEmailHtml(
      `<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><p>x</p></body></html>`,
    );

    assert.ok(out);
    assert.doesNotMatch(out, /default-src \*/);
    assert.ok(out.includes(EMAIL_CSP_META));
  });

  test("returns null for empty input", () => {
    assert.equal(sanitizeEmailHtml(""), null);
    assert.equal(sanitizeEmailHtml(null), null);
    assert.equal(sanitizeEmailHtml("   "), null);
  });
});
