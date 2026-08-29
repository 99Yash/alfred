/**
 * The recoverable-serialization path, which no test covered before the
 * per-domain split of the pull read model.
 *
 * `toEntityRow` decides whether one malformed row costs the user ONE ROW or the
 * WHOLE PULL. A narrowed predicate, a deleted `try`, or a domain `make` that
 * throws a plain `Error` where it used to throw `SerializationError` turns a
 * skipped row into a failed pull — a total sync outage for that user, from one
 * bad row, with every type check green.
 *
 * These are NEW assertions, not characterization tests: the behavior existed
 * before, but `toEntityRow` was module-private and could not be driven.
 * Env-free, so this also runs in the `http-env-free-load` job.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { z } from "zod";
import { syncedNoteSchema } from "@alfred/sync";

import { SerializationError, toEntityRow } from "../../src/sync/read/entity-row";
import type { EntityRow } from "../../src/sync/read/entity-row";

const ROW = { slug: "note", id: "note-1" } as const;

const SERIALIZED = {
  id: "note-1",
  userId: "u",
  text: "hi",
  createdAt: "2026-08-29T00:00:00.000Z",
  rowVersion: 3,
};

const ROW_MAKE: () => EntityRow<"note"> = () => ({
  id: "note-1",
  rowVersion: 3,
  serialized: SERIALIZED,
});

describe("toEntityRow recoverable-serialization skip", () => {
  test("a well-formed row becomes exactly one patch row", () => {
    assert.deepEqual(toEntityRow({ ...ROW, make: ROW_MAKE }), [
      { id: "note-1", rowVersion: 3, serialized: SERIALIZED },
    ]);
  });

  test("a ZodError skips the row instead of failing the pull", () => {
    const result = toEntityRow({
      ...ROW,
      make: () => ({
        id: "note-1",
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
