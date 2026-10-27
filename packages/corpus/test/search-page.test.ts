import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chunkMetadata } from "../src/chunk-metadata";

/** The write door before a page reaches a citation (ADR-0091; the `chunks_metadata_page_valid` CHECK owns the rule). A bad anchor writes no page, never a guess. */
describe("chunk metadata", () => {
  test("chunkMetadata is the single write door — a null page writes an empty record", () => {
    assert.deepEqual(chunkMetadata(3), { page: 3 });
    assert.deepEqual(chunkMetadata(null), {});
    assert.deepEqual(chunkMetadata(0), {});
  });
});
