import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  packEvidenceCards,
  registerContextSource,
  searchContext,
} from "@alfred/assistant/context-search";
import type { RecallMemoryArgs, RecallMemoryHit } from "@alfred/assistant/knowledge";
import {
  createMemoryContextSource,
  memoryHitToEvidenceCard,
} from "../../src/context-search/memory-source";

/**
 * Behavioral tests for the #424 memory adapter. Same shape as the document
 * adapter suite: card mapping (source, citation, score, expansion), source-local
 * ordering, request forwarding, and acceptance by the boundary + packer. The
 * recall verb is injected, so no database is needed.
 */

function makeHit(
  overrides: Partial<RecallMemoryHit> & Pick<RecallMemoryHit, "chunkId">,
): RecallMemoryHit {
  return {
    kind: "thread_summary",
    preview: "We agreed to ship on Friday.",
    similarity: 0.5,
    source: { kind: "agent", id: "run-1" },
    ...overrides,
  };
}

describe("memoryHitToEvidenceCard", () => {
  test("carries source, citation, score, expansion, and ingested freshness", () => {
    const card = memoryHitToEvidenceCard(
      makeHit({ chunkId: "mem-1", kind: "cold_start_research", similarity: 0.68 }),
    );

    assert.equal(card.id, "memory:mem-1");
    assert.deepEqual(card.source, {
      id: "memory",
      kind: "internal",
      displayName: "Memory",
    });
    assert.equal(card.mediaKind, "text");
    assert.equal(card.snippet, "We agreed to ship on Friday.");
    assert.equal(card.score, 0.68);
    assert.deepEqual(card.citations, [
      { label: "Cold Start Research", locator: "memory chunk mem-1" },
    ]);
    assert.deepEqual(card.expansion, {
      sourceId: "memory",
      kind: "memory_chunk",
      ref: "mem-1",
      hint: "Cold Start Research",
    });
    assert.deepEqual(card.time, { freshness: "ingested" });
  });

  test("names missing text honestly rather than emitting an empty snippet", () => {
    const card = memoryHitToEvidenceCard(makeHit({ chunkId: "mem-2", preview: "" }));

    assert.equal(card.snippet, undefined);
    assert.match(card.note ?? "", /no stored text/);
  });
});

describe("createMemoryContextSource", () => {
  test("forwards the request envelope to the recall primitive", async () => {
    let seen: RecallMemoryArgs | undefined;

    const source = createMemoryContextSource(async (args) => {
      seen = args;

      return [];
    });

    await source.search({ userId: "user-1", query: "Friday plan", limit: 3 });

    assert.deepEqual(seen, { userId: "user-1", query: "Friday plan", limit: 3 });
  });

  test("orders hits by score, breaking ties by chunk id", async () => {
    const source = createMemoryContextSource(async () => [
      makeHit({ chunkId: "z", similarity: 0.2 }),
      makeHit({ chunkId: "y", similarity: 0.6 }),
      makeHit({ chunkId: "x", similarity: 0.2 }),
    ]);

    const result = await source.search({ userId: "user-1", query: "q", limit: 10 });

    assert.deepEqual(
      result.evidence.map((card) => card.id),
      ["memory:y", "memory:x", "memory:z"],
    );
  });
});

describe("memory source through the read boundary", () => {
  test("a registered source yields cards the packer can cite", async () => {
    const dispose = registerContextSource(
      createMemoryContextSource(async () => [
        makeHit({
          chunkId: "mem-9",
          kind: "manual",
          similarity: 0.55,
          preview: "Remember the milk.",
        }),
      ]),
    );

    try {
      const result = await searchContext({ userId: "user-1", query: "groceries", limit: 5 });

      assert.equal(result.sources[0]?.sourceId, "memory");
      assert.equal(result.sources[0]?.status, "ok");
      assert.equal(result.evidence.length, 1);

      const packed = packEvidenceCards(result);

      assert.match(packed.text, /Memory \[memory\]/);
      assert.match(packed.text, /Remember the milk\./);
    } finally {
      dispose();
    }
  });
});
