import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { IDB_KEY_NAMES, parseSyncPullValue, SYNC_MODEL } from "../src/index";

describe("SYNC_MODEL storage keys", () => {
  test("every public key operation returns the entity prefix", () => {
    const note = {
      id: "note_1",
      userId: "user_1",
      text: "Remember this",
      createdAt: "2026-08-29T00:00:00.000Z",
      rowVersion: 2,
    };

    const prefix: "note/" = SYNC_MODEL.note.prefix;
    const storageKey: `note/${string}` = SYNC_MODEL.note.storageKeyForId(note.id);

    assert.equal(prefix, "note/");
    assert.equal(storageKey, "note/note_1");
    assert.equal(SYNC_MODEL.note.storageKeyFor(note), "note/note_1");
  });

  test("keeps non-id identity rules inside the model", () => {
    const preference = {
      key: "tone",
      userId: "user_1",
      value: "brief" as const,
      source: { kind: "user" as const },
      rowVersion: 1,
    };

    assert.equal(SYNC_MODEL.pref.storageKeyFor(preference), "pref/tone");
  });

  test("derives every prefix from its registry key", () => {
    for (const rawPrefix of IDB_KEY_NAMES) {
      assert.equal(SYNC_MODEL[rawPrefix].prefix, `${rawPrefix}/`);
    }
  });
});

describe("SYNC_MODEL pull parsing", () => {
  test("derives CVR identity and version from the parsed value", () => {
    const parsed = parseSyncPullValue("note", {
      id: "note_1",
      userId: "user_1",
      text: "Remember this",
      createdAt: "2026-08-29T00:00:00.000Z",
      rowVersion: 7,
    });

    assert.equal(parsed.id, "note_1");
    assert.equal(parsed.rowVersion, 7);
  });

  test("keeps the persisted wire schema strict", () => {
    assert.throws(() =>
      parseSyncPullValue("note", {
        id: "note_1",
        userId: "user_1",
        text: "Remember this",
        createdAt: new Date("2026-08-29T00:00:00.000Z"),
        rowVersion: 7,
      }),
    );
  });
});
