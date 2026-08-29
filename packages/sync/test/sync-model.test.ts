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

    const prefix: "note/" = SYNC_MODEL.NOTE.prefix;
    const storageKey: `note/${string}` = SYNC_MODEL.NOTE.storageKeyForId(note.id);

    assert.equal(prefix, "note/");
    assert.equal(storageKey, "note/note_1");
    assert.equal(SYNC_MODEL.NOTE.storageKeyFor(note), "note/note_1");
  });

  test("keeps non-id identity rules inside the model", () => {
    const preference = {
      key: "tone",
      userId: "user_1",
      value: "brief" as const,
      source: { kind: "user" as const },
      rowVersion: 1,
    };

    assert.equal(SYNC_MODEL.PREFERENCE.storageKeyFor(preference), "pref/tone");
  });

  test("uses unique prefixes for every registered entity", () => {
    const prefixes = IDB_KEY_NAMES.map((slug) => SYNC_MODEL[slug].prefix);

    assert.equal(new Set(prefixes).size, IDB_KEY_NAMES.length);
  });
});

describe("SYNC_MODEL pull parsing", () => {
  test("derives CVR identity and version from the parsed value", () => {
    const parsed = parseSyncPullValue("NOTE", {
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
      parseSyncPullValue("NOTE", {
        id: "note_1",
        userId: "user_1",
        text: "Remember this",
        createdAt: new Date("2026-08-29T00:00:00.000Z"),
        rowVersion: 7,
      }),
    );
  });
});
