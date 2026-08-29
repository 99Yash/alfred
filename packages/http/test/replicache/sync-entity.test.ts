import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { DbTransaction } from "@alfred/db";
import { SYNC_MODEL } from "@alfred/sync";

import { syncEntity } from "../../src/sync/read/sync-entity";

// SAFETY: the test query ignores its transaction; this inert adapter reaches only the reader seam.
const UNUSED_TX = {} as DbTransaction;

describe("syncEntity", () => {
  test("serializes Dates, strips server fields, and derives CVR fields", async () => {
    const fetchNotes = syncEntity(SYNC_MODEL.note, {
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
        storageKey: "note/note_1",
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

  test("logs a bounded diagnostic and isolates a runtime-invalid projection", async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: unknown) => {
      warnings.push(String(message));
    });
    const mapped = {
      id: "note_1",
      userId: "user_1",
      text: 42,
      createdAt: new Date("2026-08-29T00:00:00.000Z"),
      rowVersion: 4,
      diagnosticPadding: `included-before-the-boundary-${"x".repeat(220)}excluded-after-boundary`,
    };
    const fetchNotes = syncEntity(SYNC_MODEL.note, {
      query: async () => [mapped],
      map: (row) => row,
    });

    assert.deepEqual(await fetchNotes(UNUSED_TX, "user_1"), []);
    const preview = JSON.stringify(mapped).slice(0, 200);
    assert.equal(warnings[0], `[replicache] invalid note row at text; mapped value: ${preview}`);
    assert.equal(preview.length, 200);
    assert.ok(!warnings[0]?.includes("excluded-after-boundary"));
  });

  test("an unserializable diagnostic preview cannot fail the pull", async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: unknown) => {
      warnings.push(String(message));
    });
    const fetchNotes = syncEntity(SYNC_MODEL.note, {
      query: async () => [
        {
          id: "note_1",
          userId: "user_1",
          text: 42,
          createdAt: new Date("2026-08-29T00:00:00.000Z"),
          rowVersion: 4,
          diagnosticOnly: 1n,
        },
      ],
      map: (row) => row,
    });

    assert.deepEqual(await fetchNotes(UNUSED_TX, "user_1"), []);
    assert.equal(
      warnings[0],
      "[replicache] invalid note row at text; mapped value: <unserializable mapped value>",
    );
  });
});
