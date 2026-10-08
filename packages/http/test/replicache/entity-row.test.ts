/**
 * `toEntityRow` decides if one malformed row costs one row or the whole pull.
 * A narrowed predicate, a deleted `try`, or a plain `Error` instead of `SerializationError`
 * turns a skipped row into a failed pull, with every type check green.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { z } from "zod";
import { syncedNoteSchema } from "@alfred/sync";

import { SerializationError, toEntityRow } from "../../src/sync/read/entity-row";
import type { EntityRow } from "../../src/sync/read/entity-row";

const ROW = { slug: "note" } as const;

const SERIALIZED = {
  id: "note-1",
  userId: "u",
  text: "hi",
  createdAt: "2026-08-29T00:00:00.000Z",
  rowVersion: 3,
};

const ROW_MAKE: () => EntityRow<"note"> = () => ({
  id: "note-1",
  storageKey: "note/note-1",
  rowVersion: 3,
  serialized: SERIALIZED,
});

describe("toEntityRow recoverable-serialization skip", () => {
  test("a well-formed row becomes exactly one patch row", () => {
    assert.deepEqual(toEntityRow({ ...ROW, make: ROW_MAKE }), [
      { id: "note-1", storageKey: "note/note-1", rowVersion: 3, serialized: SERIALIZED },
    ]);
  });

  test("a ZodError skips the row instead of failing the pull", () => {
    const result = toEntityRow({
      ...ROW,
      make: () => ({
        id: "note-1",
        storageKey: "note/note-1",
        rowVersion: 3,
        serialized: syncedNoteSchema.parse(z.object({ id: z.string() }).parse({})),
      }),
    });

    assert.deepEqual(result, []);
  });

  test("a SerializationError skips the row instead of failing the pull", () => {
    const result = toEntityRow({
      ...ROW,
      make: (): EntityRow<"note"> => {
        throw new SerializationError("notes.createdAt must not be null");
      },
    });

    assert.deepEqual(result, []);
  });

  test("any other error still fails the pull", () => {
    assert.throws(
      () =>
        toEntityRow({
          ...ROW,
          make: (): EntityRow<"note"> => {
            throw new TypeError("the connection dropped mid-serialize");
          },
        }),
      TypeError,
    );
  });
});
