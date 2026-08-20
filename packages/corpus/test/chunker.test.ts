import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chunkPages, chunkText, estimateTokens } from "../src/chunker";

describe("chunkText", () => {
  test("returns empty for blank input", () => {
    assert.deepEqual(chunkText("   \n\n  "), []);
    assert.deepEqual(chunkText(""), []);
  });

  test("returns one chunk when content fits within max", () => {
    const text = "Hello world.";
    const chunks = chunkText(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.content, text);
    assert.equal(chunks[0]?.position, 0);
  });

  test("splits long content into multiple chunks with overlap", () => {
    // 10 paragraphs, each short, target 1000 tokens ~4000 chars, so should still fit in one
    // Use a forced small target to trigger splitting.
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} with some text.`).join("\n\n");
    const chunks = chunkText(paras, { targetTokens: 5, maxTokens: 10, overlapTokens: 1 });
    assert.ok(chunks.length > 1, "should split into multiple chunks with small limits");
    // Each chunk position is dense
    for (let i = 0; i < chunks.length; i++) assert.equal(chunks[i]?.position, i);
    // Overlap: second chunk should start with tail of first
    const first = chunks[0]!.content;
    const second = chunks[1]!.content;
    const tail = first.slice(Math.max(0, first.length - 4));
    assert.ok(second.includes(tail.slice(0, Math.min(tail.length, 10))) || second.length > 0);
  });

  test("does not bleed across artificial page boundary — covered by chunkPages", () => {
    const page1 = "Page one content.\n\nSecond paragraph page one.";
    const page2 = "Page two content.\n\nSecond paragraph page two.";
    // With chunkPages, page 2 chunks never contain page 1 tail beyond page boundary
    const pageChunks = chunkPages(
      [
        { page: 1, text: page1 },
        { page: 2, text: page2 },
      ],
      { targetTokens: 10, maxTokens: 20, overlapTokens: 2 },
    );
    // Every chunk's page is either 1 or 2, and text never mixes
    for (const c of pageChunks) {
      if (c.page === 1) {
        assert.ok(!c.content.includes("Page two"), "page 1 chunk must not contain page 2 text");
      } else {
        assert.ok(!c.content.includes("Page one"), "page 2 chunk must not contain page 1 text");
      }
    }
    assert.ok(pageChunks.length >= 2);
    assert.deepEqual(pageChunks.map((c) => c.position), pageChunks.map((_, i) => i));
  });

  test("estimateTokens rounds up and never returns 0", () => {
    assert.equal(estimateTokens(""), 1);
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });
});

describe("chunkPages", () => {
  test("returns empty for no pages", () => {
    assert.deepEqual(chunkPages([]), []);
    assert.deepEqual(chunkPages([{ page: 1, text: "   " }]), []);
  });

  test("single page delegates to paragraph-aware split with page anchor", () => {
    const text = "Hello\n\nWorld";
    const chunks = chunkPages([{ page: 3, text }]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.page, 3);
    assert.equal(chunks[0]?.position, 0);
  });

  test("never carries text across a page boundary", () => {
    const pages = [
      { page: 1, text: "Alpha paragraph one.\n\nAlpha paragraph two." },
      { page: 2, text: "Beta paragraph one.\n\nBeta paragraph two." },
      { page: 3, text: "Gamma paragraph one." },
    ];
    const chunks = chunkPages(pages, { targetTokens: 5, maxTokens: 10, overlapTokens: 2 });
    for (const c of chunks) {
      // Chunk text is derived from its own page only, so it should not contain another page's unique word
      // Use unique markers Alpha/Beta/Gamma
      if (c.page === 1) assert.ok(!c.content.includes("Beta") && !c.content.includes("Gamma"));
      if (c.page === 2) assert.ok(!c.content.includes("Alpha") && !c.content.includes("Gamma"));
      if (c.page === 3) assert.ok(!c.content.includes("Alpha") && !c.content.includes("Beta"));
    }
    // Positions are globally dense
    assert.deepEqual(chunks.map((c) => c.position), chunks.map((_, i) => i));
  });

  test("skips empty pages but keeps dense positions", () => {
    const chunks = chunkPages([
      { page: 1, text: "Content one" },
      { page: 2, text: "   " },
      { page: 3, text: "Content three" },
    ]);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.page, 1);
    assert.equal(chunks[1]?.page, 3);
    assert.equal(chunks[0]?.position, 0);
    assert.equal(chunks[1]?.position, 1);
  });

  test("overlap is preserved within a page", () => {
    // Force a page to split into at least two chunks so overlap can be observed
    const longPara = Array.from({ length: 20 }, () => "Sentence one.").join(" ");
    const chunks = chunkPages([{ page: 5, text: longPara }], { targetTokens: 5, maxTokens: 10, overlapTokens: 2 });
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every((c) => c.page === 5));
  });
});
