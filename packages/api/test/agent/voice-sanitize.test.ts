import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createVoiceStreamSanitizer, sanitizeVoice } from "../../src/modules/agent/voice-sanitize";

/** Run a set of raw deltas through the streaming sanitizer and concat the result. */
function stream(chunks: string[]): string {
  const s = createVoiceStreamSanitizer();
  let out = "";
  for (const c of chunks) out += s.push(c);
  out += s.flush();
  return out;
}

describe("sanitizeVoice — batch", () => {
  test("spaced em-dash becomes a clause boundary", () => {
    assert.equal(
      sanitizeVoice("the real thing — not the commit"),
      "the real thing; not the commit",
    );
  });

  test("unspaced em-dash becomes a clause boundary", () => {
    assert.equal(sanitizeVoice("email—finding"), "email; finding");
  });

  test("multiple em-dashes", () => {
    assert.equal(sanitizeVoice("a — b — c"), "a; b; c");
  });

  test("numeric and word ranges keep their meaning with a hyphen", () => {
    assert.equal(sanitizeVoice("9–11am"), "9-11am");
    assert.equal(sanitizeVoice("10 – 20"), "10-20");
    assert.equal(sanitizeVoice("Monday–Friday"), "Monday-Friday");
    assert.equal(sanitizeVoice("A – Z"), "A-Z");
  });

  test("no dashes is identity (same reference fast-path)", () => {
    const s = "Nothing pressing today. Enjoy the weekend.";
    assert.equal(sanitizeVoice(s), s);
  });

  test("leaves em-dash inside inline code", () => {
    assert.equal(sanitizeVoice("run `foo—bar` now"), "run `foo—bar` now");
  });

  test("leaves em-dash inside fenced code", () => {
    const s = "before\n```\nconst x = a—b\n```\nafter — done";
    assert.equal(sanitizeVoice(s), "before\n```\nconst x = a—b\n```\nafter; done");
  });

  test("preserves quoted and blockquoted source text", () => {
    assert.equal(
      sanitizeVoice("She wrote “keep this — exactly” and left — quickly."),
      "She wrote “keep this — exactly” and left; quickly.",
    );
    assert.equal(sanitizeVoice("> source — text\nanswer — now"), "> source — text\nanswer; now");
  });

  test("preserves newlines (only spaces/tabs are eaten around a dash)", () => {
    const out = sanitizeVoice("line one\n— line two");
    assert.ok(out.includes("line one\n"), out);
    assert.ok(!out.includes("—"), out);
  });

  test("collapses an adjacent-dash run", () => {
    assert.equal(sanitizeVoice("a —— b"), "a; b");
  });
});

describe("createVoiceStreamSanitizer — straddling deltas", () => {
  test("dash split across three deltas collapses correctly", () => {
    assert.equal(
      stream(["the real thing", " — ", "not the commit"]),
      "the real thing; not the commit",
    );
  });

  test("bare dash char in its own delta", () => {
    assert.equal(stream(["a", "—", "b"]), "a; b");
  });

  test("trailing dash at end of stream is dropped, not stranded", () => {
    assert.equal(stream(["done —"]), "done");
  });

  test("held whitespace is emitted, not lost", () => {
    assert.equal(stream(["hello ", "world"]), "hello world");
  });

  test("clean prose streams through unchanged", () => {
    assert.equal(
      stream(["Two things ", "need you ", "today. ", "Rotate the key."]),
      "Two things need you today. Rotate the key.",
    );
  });

  test("matches batch output for the same full text", () => {
    const full = "You're set — go breathe. Nothing else on the calendar.";
    assert.equal(
      stream(["You're set", " — go", " breathe.", " Nothing else on the calendar."]),
      sanitizeVoice(full),
    );
  });

  test("preserves inline code when a provider chunk splits the code span", () => {
    assert.equal(stream(["run `foo", "—bar` now"]), "run `foo—bar` now");
  });

  test("preserves fenced code when a provider chunk splits the fence body", () => {
    assert.equal(
      stream(["before\n```ts\nconst x = a", "—b\n```\nafter — done"]),
      "before\n```ts\nconst x = a—b\n```\nafter; done",
    );
  });

  test("recognizes a word range split across provider chunks", () => {
    assert.equal(stream(["Monday", "–", "Friday"]), "Monday-Friday");
  });

  test("streaming is invariant across every two-chunk split", () => {
    const samples = [
      "Use `a—b`, then continue — carefully.",
      '```ts\nconst range = "Monday–Friday";\n```\nDone — now.',
      "Keep “quoted — punctuation” exact — outside it.",
      "> quoted — source\nThe answer — concise.",
    ];
    for (const sample of samples) {
      const expected = sanitizeVoice(sample);
      for (let split = 0; split <= sample.length; split += 1) {
        assert.equal(
          stream([sample.slice(0, split), sample.slice(split)]),
          expected,
          `split=${split}`,
        );
      }
    }
  });
});
