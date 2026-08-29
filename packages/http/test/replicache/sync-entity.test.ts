import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { DbTransaction } from "@alfred/db";

import { syncEntity } from "../../src/sync/read/sync-entity";

// SAFETY: the test query ignores its transaction; this inert adapter reaches only the reader seam.
const UNUSED_TX = {} as DbTransaction;

describe("syncEntity", () => {
  test("serializes Dates, strips server fields, and derives CVR fields", async () => {
    const fetchNotes = syncEntity("NOTE", {
      query: async () => [
        {
          id: "note_1",
          userId: "user_1",
          text: "Remember this",
          createdAt: new Date("2026-08-29T00:00:00.000Z"),
          rowVersion: 4,
          serverOnly: "not synced",
        },
      ],
      map: (row) => row,
    });

    const rows = await fetchNotes(UNUSED_TX, "user_1");

    assert.deepEqual(rows, [
      {
        id: "note_1",
        rowVersion: 4,
        serialized: {
          id: "note_1",
          userId: "user_1",
          text: "Remember this",
          createdAt: "2026-08-29T00:00:00.000Z",
          rowVersion: 4,
        },
      },
    ]);
  });

  test("isolates a row that has a runtime-invalid projection", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const fetchNotes = syncEntity("NOTE", {
      query: async () => [
        {
          id: "note_1",
          userId: "user_1",
          text: "Remember this",
          createdAt: "not-a-date",
          rowVersion: 4,
        },
      ],
      map: (row) => row,
    });

    assert.deepEqual(await fetchNotes(UNUSED_TX, "user_1"), []);
  });
});
