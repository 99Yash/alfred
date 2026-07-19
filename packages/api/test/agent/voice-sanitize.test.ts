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
    assert.equal(sanitizeVoice("10 – 20"), "10 - 20");
    assert.equal(sanitizeVoice("Monday–Friday"), "Monday-Friday");
    assert.equal(sanitizeVoice("A – Z"), "A - Z");
  });

  test("spaced en-dash prose never joins unrelated words", () => {
    assert.equal(sanitizeVoice("the deploy – failed again"), "the deploy - failed again");
    assert.equal(
      sanitizeVoice("This matters – because users notice"),
      "This matters - because users notice",
    );
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

  test("preserves markdown destinations and raw URLs", () => {
    assert.equal(
      sanitizeVoice("See [the docs](https://example.com/a—b) — now."),
      "See [the docs](https://example.com/a—b); now.",
    );
    assert.equal(
      sanitizeVoice("Open https://example.com/a—b — now."),
      "Open https://example.com/a—b; now.",
    );
    assert.equal(
      sanitizeVoice("Open https://example.com/a--b -- now."),
      "Open https://example.com/a--b; now.",
    );
  });

  test("an inches mark does not hide the rest of the line", () => {
    assert.equal(sanitizeVoice('The 6" display — ships today.'), 'The 6" display; ships today.');
  });

  test("double hyphens used as a dash become a clause boundary", () => {
    assert.equal(sanitizeVoice("ready -- ship it"), "ready; ship it");
    assert.equal(sanitizeVoice("ready--ship it"), "ready; ship it");
    assert.equal(sanitizeVoice("well-known"), "well-known");
  });

  test("preserves markdown thematic breaks and frontmatter delimiters", () => {
    assert.equal(sanitizeVoice("before\n---\nafter — done"), "before\n---\nafter; done");
    assert.equal(sanitizeVoice("---\ntitle: Briefing\n---"), "---\ntitle: Briefing\n---");
  });

  test("preserves newlines (only spaces/tabs are eaten around a dash)", () => {
    const out = sanitizeVoice("line one\n— line two");
    assert.ok(out.includes("line one\n"), out);
    assert.ok(!out.includes("—"), out);
  });

  test("collapses an adjacent-dash run", () => {
    assert.equal(sanitizeVoice("a —— b"), "a; b");
  });

  test("preserves a GFM table delimiter row", () => {
    const table = "| Layer | How it works |\n| --- | --- |\n| a | b — c |";
    assert.equal(sanitizeVoice(table), "| Layer | How it works |\n| --- | --- |\n| a | b; c |");
  });

  test("preserves tight and alignment delimiter rows", () => {
    assert.equal(
      sanitizeVoice("| a | b |\n|---|---|\n| 1 | 2 |"),
      "| a | b |\n|---|---|\n| 1 | 2 |",
    );
    assert.equal(
      sanitizeVoice("| a | b |\n| :--- | ---: |\n| 1 | 2 |"),
      "| a | b |\n| :--- | ---: |\n| 1 | 2 |",
    );
  });

  test("still sanitizes dashes inside table content cells", () => {
    assert.equal(
      sanitizeVoice("| col |\n| --- |\n| the plan — shipped |"),
      "| col |\n| --- |\n| the plan; shipped |",
    );
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

  test("preserves a table delimiter row split across provider chunks", () => {
    assert.equal(
      stream(["| a | b |\n| ---", " | --- |\n", "| 1 | 2 |"]),
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  test("streaming is invariant across every two-chunk split", () => {
    const samples = [
      "Use `a—b`, then continue — carefully.",
      '```ts\nconst range = "Monday–Friday";\n```\nDone — now.',
      "Keep “quoted — punctuation” exact — outside it.",
      "> quoted — source\nThe answer — concise.",
      "See [docs](https://example.com/a—b) — now.",
      "ready -- ship it",
      "before\n---\nafter — done",
      "---\ntitle: Briefing\n---",
      "| Layer | How it works |\n| --- | --- |\n| retry | backs off — then throws |",
      "| a | b |\n|:--|--:|\n| 1 | 2 |",
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
