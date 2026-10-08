import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chunkMetadata, extractPageFromMetadata } from "../src/chunk-metadata";

/** The last gate before a page reaches a citation (ADR-0091). A bad anchor yields `null`, never a guess. */
describe("chunk metadata", () => {
  test("chunkMetadata is the single write door — a null page writes an empty record", () => {
    assert.deepEqual(chunkMetadata(3), { page: 3 });
    assert.deepEqual(chunkMetadata(null), {});
    assert.deepEqual(chunkMetadata(0), {});
  });

  test("the write door round-trips through the read gate", () => {
    assert.equal(extractPageFromMetadata(chunkMetadata(3)), 3);
    assert.equal(extractPageFromMetadata(chunkMetadata(null)), null);
  });

  test("reads a 1-indexed page off stored chunk metadata", () => {
    assert.equal(extractPageFromMetadata({ page: 1 }), 1);
    assert.equal(extractPageFromMetadata({ page: 12 }), 12);
  });

  test("yields null when no page was proved", () => {
    assert.equal(extractPageFromMetadata({}), null);
    assert.equal(extractPageFromMetadata(null), null);
    assert.equal(extractPageFromMetadata("page 3"), null);
  });

  test("rejects non-integer, zero, negative, and non-numeric values", () => {
    assert.equal(extractPageFromMetadata({ page: 0 }), null);
    assert.equal(extractPageFromMetadata({ page: -2 }), null);
    assert.equal(extractPageFromMetadata({ page: 1.5 }), null);
    assert.equal(extractPageFromMetadata({ page: "3" }), null);
    assert.equal(extractPageFromMetadata({ page: [3] }), null);
  });
});
