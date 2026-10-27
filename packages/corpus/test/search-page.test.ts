import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chunkMetadata } from "../src/chunk-metadata";

/** The only gate before a page reaches a citation (ADR-0091). A bad anchor writes no page, never a guess. */
describe("chunk metadata", () => {
  test("chunkMetadata is the single write door — a null page writes an empty record", () => {
    assert.deepEqual(chunkMetadata(3), { page: 3 });
    assert.deepEqual(chunkMetadata(null), {});
    assert.deepEqual(chunkMetadata(0), {});
  });
});
