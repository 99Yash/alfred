import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  packEvidenceCards,
  registerContextSource,
  searchContext,
} from "@alfred/assistant/context-search";
import type { SearchArgs, SearchHit } from "@alfred/corpus";
import {
  createDocumentContextSource,
  documentHitToEvidenceCard,
} from "../../src/context-search/documents-source";

/**
 * Behavioral tests for the #424 document adapter.
 *
 * These cover what the compiler cannot: that a corpus hit maps to an
 * attribution-complete card (source, citation, score, expansion handle), that
 * the adapter orders its hits deterministically, that it forwards the request
 * envelope to the primitive, and that the boundary accepts its cards and the
 * packer renders their citations. The primitive is injected, so no database is
 * needed. The card shape itself is proven by `evidenceCardSchema` at the
 * boundary, not by a schema round-trip here.
 */

function makeHit(overrides: Partial<SearchHit> & Pick<SearchHit, "chunkId">): SearchHit {
  return {
    documentId: `doc-${overrides.chunkId}`,
    source: "gmail",
    title: "Quarterly plan",
    position: 0,
    page: null,
    preview: "The quarterly plan is attached.",
    similarity: 0.5,
    authoredAt: null,
    ...overrides,
  };
}

describe("documentHitToEvidenceCard", () => {
  test("carries source, citation, score, expansion, and ingested freshness", () => {
    const card = documentHitToEvidenceCard(
      makeHit({
        chunkId: "chunk-1",
        documentId: "doc-1",
        title: "Board deck",
        url: "https://mail.google.com/mail/u/0/#all/abc",
        page: 3,
        similarity: 0.82,
        authoredAt: new Date("2026-09-01T12:00:00.000Z"),
      }),
    );

    assert.equal(card.id, "documents:chunk-1");
    assert.deepEqual(card.source, {
      id: "documents",
      kind: "internal",
      displayName: "Documents",
    });
    assert.equal(card.mediaKind, "document");
    assert.equal(card.snippet, "The quarterly plan is attached.");
    assert.equal(card.score, 0.82);
    assert.deepEqual(card.citations, [
      {
        label: "Board deck",
        url: "https://mail.google.com/mail/u/0/#all/abc",
        locator: "page 3",
      },
    ]);
    assert.deepEqual(card.expansion, {
      sourceId: "documents",
      kind: "document",
      ref: "doc-1",
      hint: "Board deck",
    });
    assert.deepEqual(card.time, {
      observedAt: "2026-09-01T12:00:00.000Z",
      freshness: "ingested",
    });
  });

  test("falls back to the provider name when a hit has no title", () => {
    const card = documentHitToEvidenceCard(
      makeHit({ chunkId: "chunk-2", title: null, source: "github" }),
    );

    assert.equal(card.citations?.[0]?.label, "Github");
    assert.equal(card.expansion?.hint, undefined);
  });

  test("names missing text honestly rather than emitting an empty snippet", () => {
    const card = documentHitToEvidenceCard(makeHit({ chunkId: "chunk-3", preview: "" }));

    assert.equal(card.snippet, undefined);
    assert.match(card.note ?? "", /No extracted text/);
  });
});

describe("createDocumentContextSource", () => {
  test("forwards the request envelope to the search primitive", async () => {
    let seen: SearchArgs | undefined;

    const source = createDocumentContextSource(async (args) => {
      seen = args;

      return [];
    });

    await source.search({ userId: "user-1", query: "deploy status", task: "chat", limit: 7 });

    assert.deepEqual(seen, { userId: "user-1", query: "deploy status", limit: 7 });
  });

  test("orders hits by score, breaking ties by chunk id", async () => {
    const source = createDocumentContextSource(async () => [
      makeHit({ chunkId: "b", similarity: 0.4 }),
      makeHit({ chunkId: "c", similarity: 0.9 }),
      makeHit({ chunkId: "a", similarity: 0.4 }),
    ]);

    const result = await source.search({ userId: "user-1", query: "q", limit: 10 });

    assert.deepEqual(
      result.evidence.map((card) => card.id),
      ["documents:c", "documents:a", "documents:b"],
    );
    assert.deepEqual(
      result.evidence.map((card) => card.score),
      [0.9, 0.4, 0.4],
    );
  });
});

describe("document source through the read boundary", () => {
  test("a registered source yields cards the packer can cite", async () => {
    const dispose = registerContextSource(
      createDocumentContextSource(async () => [
        makeHit({
          chunkId: "chunk-9",
          documentId: "doc-9",
          title: "Incident retro",
          similarity: 0.77,
        }),
      ]),
    );

    try {
      const result = await searchContext({ userId: "user-1", query: "what happened", limit: 5 });

      assert.equal(result.sources[0]?.sourceId, "documents");
      assert.equal(result.sources[0]?.status, "ok");
      assert.equal(result.evidence.length, 1);

      const packed = packEvidenceCards(result);

      assert.match(packed.text, /Documents \[documents\]/);
      assert.match(packed.text, /Incident retro/);
    } finally {
      dispose();
    }
  });
});
