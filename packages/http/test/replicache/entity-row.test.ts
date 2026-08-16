/**
 * The recoverable-serialization path, which no test covered before the
 * per-domain split of the pull read model.
 *
 * `toEntityRow` decides whether one malformed row costs the user ONE ROW or the
 * WHOLE PULL. A narrowed predicate, a deleted `try`, or a domain serializer that
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

import { SerializationError, toEntityRow } from "../../src/sync/read/entity-row";

const ROW = { slug: "NOTE", id: "note-1", rowVersion: 3 } as const;

describe("toEntityRow recoverable-serialization skip", () => {
  test("a well-formed row becomes exactly one patch row", () => {
    const serialized = { id: "note-1", userId: "u", text: "hi", createdAt: "x", rowVersion: 3 };
    assert.deepEqual(toEntityRow({ ...ROW, serialize: () => serialized as never }), [
      { id: "note-1", rowVersion: 3, serialized },
    ]);
  });

  test("a ZodError skips the row instead of failing the pull", () => {
    const result = toEntityRow({
      ...ROW,
      serialize: () => z.object({ id: z.string() }).parse({}) as never,
    });
    assert.deepEqual(result, []);
  });

  test("a SerializationError skips the row instead of failing the pull", () => {
    const result = toEntityRow({
      ...ROW,
      serialize: (): never => {
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
          serialize: (): never => {
            throw new TypeError("the connection dropped mid-serialize");
          },
        }),
      TypeError,
    );
  });
});
