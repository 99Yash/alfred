import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ReadTransaction, ReadonlyJSONValue, WriteTransaction } from "replicache";

import { IDB_KEY_NAMES, SYNC_MODEL, type SyncStringKey } from "../src/index";

const note = {
  id: "note_1",
  userId: "user_1",
  text: "Remember this",
  createdAt: "2026-08-29T00:00:00.000Z",
  rowVersion: 2,
};

function scanTransaction(
  values: readonly ReadonlyJSONValue[],
  prefixes: string[],
): Pick<ReadTransaction, "scan"> {
  return {
    // SAFETY: the model only calls the unindexed scan overload and consumes
    // values().toArray(); this fake implements that exact capability.
    scan: ((options?: { prefix?: string }) => {
      prefixes.push(options?.prefix ?? "");
      return {
        values: () => ({
          toArray: async () => [...values],
        }),
      };
    }) as Pick<ReadTransaction, "scan">["scan"],
  };
}

function assertModelOperationTypes(
  readTx: Pick<ReadTransaction, "get">,
  writeTx: Pick<WriteTransaction, "set">,
): void {
  const result: Promise<typeof note | null> = SYNC_MODEL.note.get(readTx, { id: "note_1" });
  void result;
  // @ts-expect-error the model owns its schema; callers cannot provide another one
  void SYNC_MODEL.note.get(readTx, { id: "note_1" }, SYNC_MODEL.fact.schema);
  const wrongModelValue = {
    id: "todo_1",
    userId: "user_1",
    name: "Wrong model",
    status: "open",
    createdBy: "user",
    executor: "user",
    kind: "task",
    rowVersion: 1,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  // @ts-expect-error a note model cannot write a todo
  void SYNC_MODEL.note.put(writeTx, wrongModelValue);
  // @ts-expect-error workflow identity is its slug, not an arbitrary entity id
  void SYNC_MODEL.workflow.storageKeyForId({ id: "todo_1" });
  // @ts-expect-error a full briefing identity includes both ordered fields
  void SYNC_MODEL.briefing.storageKeyForId({ briefingDate: "2026-08-29" });
  // @ts-expect-error a briefing scan prefix must start with briefingDate
  void SYNC_MODEL.briefing.scanPrefix(scanTransaction([], []), { slot: "morning" });

  // @ts-expect-error rowVersion is not a string-valued identity field
  const nonStringKey: SyncStringKey<typeof SYNC_MODEL.note.schema> = "rowVersion";
  // @ts-expect-error missing is not a schema field
  const missingKey: SyncStringKey<typeof SYNC_MODEL.note.schema> = "missing";
  void nonStringKey;
  void missingKey;

  const mismatchedRegistry = {
    note: SYNC_MODEL.fact,
  };
  // @ts-expect-error an entry's explicit prefix must match its registry key
  void (mismatchedRegistry satisfies {
    [K in keyof typeof mismatchedRegistry]: { prefix: `${K}/` };
  });
}
void assertModelOperationTypes;

describe("SYNC_MODEL storage keys", () => {
  test("every public key operation returns the entity prefix", () => {
    const prefix: "note/" = SYNC_MODEL.note.prefix;
    const storageKey: `note/${string}` = SYNC_MODEL.note.storageKeyForId({ id: note.id });

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
    assert.equal(SYNC_MODEL.pref.storageKeyForId({ key: "tone" }), "pref/tone");
    assert.equal(
      SYNC_MODEL.briefing.storageKeyForId({
        briefingDate: "2026-08-29",
        slot: "morning",
      }),
      "briefing/2026-08-29/morning",
    );
  });

  test("derives every prefix from its registry key", () => {
    for (const rawPrefix of IDB_KEY_NAMES) {
      assert.equal(SYNC_MODEL[rawPrefix].prefix, `${rawPrefix}/`);
    }
  });

  test("keeps every persisted model key byte-compatible", () => {
    // ADR-0061: these key bytes are the existing Replicache store and CVR protocol contract.
    assert.deepEqual(IDB_KEY_NAMES, [
      "note",
      "fact",
      "briefing",
      "pref",
      "skill",
      "skillrev",
      "skillrun",
      "actionstaging",
      "actionpolicy",
      "workflow",
      "todo",
      "chatthread",
      "chatmsg",
      "chatatt",
      "artifact",
      "triagetag",
    ]);
    assert.equal(SYNC_MODEL.note.storageKeyForId({ id: "n1" }), "note/n1");
    assert.equal(SYNC_MODEL.fact.storageKeyForId({ id: "f1" }), "fact/f1");
    assert.equal(
      SYNC_MODEL.briefing.storageKeyForId({
        briefingDate: "2026-08-29",
        slot: "morning",
      }),
      "briefing/2026-08-29/morning",
    );
    assert.equal(SYNC_MODEL.pref.storageKeyForId({ key: "tone" }), "pref/tone");
    assert.equal(SYNC_MODEL.skill.storageKeyForId({ id: "s1" }), "skill/s1");
    assert.equal(SYNC_MODEL.skillrev.storageKeyForId({ id: "sr1" }), "skillrev/sr1");
    assert.equal(SYNC_MODEL.skillrun.storageKeyForId({ id: "run1" }), "skillrun/run1");
    assert.equal(
      SYNC_MODEL.actionstaging.storageKeyForId({ id: "stage1" }),
      "actionstaging/stage1",
    );
    assert.equal(SYNC_MODEL.actionpolicy.storageKeyForId({ userId: "u1" }), "actionpolicy/u1");
    assert.equal(SYNC_MODEL.workflow.storageKeyForId({ slug: "daily" }), "workflow/daily");
    assert.equal(SYNC_MODEL.todo.storageKeyForId({ id: "t1" }), "todo/t1");
    assert.equal(SYNC_MODEL.chatthread.storageKeyForId({ id: "ct1" }), "chatthread/ct1");
    assert.equal(SYNC_MODEL.chatmsg.storageKeyForId({ id: "cm1" }), "chatmsg/cm1");
    assert.equal(SYNC_MODEL.chatatt.storageKeyForId({ id: "ca1" }), "chatatt/ca1");
    assert.equal(SYNC_MODEL.artifact.storageKeyForId({ id: "a1" }), "artifact/a1");
    assert.equal(
      SYNC_MODEL.triagetag.storageKeyForId({ threadId: "thread1" }),
      "triagetag/thread1",
    );
  });
});

describe("SYNC_MODEL client operations", () => {
  test("scans the bound prefix and drops malformed rows", async () => {
    const prefixes: string[] = [];
    const tx = scanTransaction([note, { ...note, id: 42 }, { ...note, id: "note_2" }], prefixes);

    assert.deepEqual(await SYNC_MODEL.note.scan(tx), [note, { ...note, id: "note_2" }]);
    assert.deepEqual(prefixes, ["note/"]);
  });

  test("forms a bounded scan prefix from the model identity", async () => {
    const prefixes: string[] = [];
    const tx = scanTransaction([], prefixes);

    await SYNC_MODEL.briefing.scanPrefix(tx, { briefingDate: "2026-08-29" });

    assert.deepEqual(prefixes, ["briefing/2026-08-29/"]);
  });

  test("gets valid rows and maps absent or malformed rows to null", async () => {
    const keys: string[] = [];
    const values: Array<ReadonlyJSONValue | undefined> = [note, undefined, { ...note, id: 42 }];
    const tx: Pick<ReadTransaction, "get"> = {
      get: async (key: string) => {
        keys.push(key);
        return values.shift();
      },
    };

    assert.deepEqual(await SYNC_MODEL.note.get(tx, { id: "note_1" }), note);
    assert.equal(await SYNC_MODEL.note.get(tx, { id: "missing" }), null);
    assert.equal(await SYNC_MODEL.note.get(tx, { id: "malformed" }), null);
    assert.deepEqual(keys, ["note/note_1", "note/missing", "note/malformed"]);
  });

  test("parses and normalizes before deriving the write key", async () => {
    const writes: Array<readonly [string, ReadonlyJSONValue]> = [];
    const tx: Pick<WriteTransaction, "set"> = {
      set: async (key, value) => {
        writes.push([key, value]);
      },
    };
    const input = { ...note, ignored: "schema strips this" };

    await SYNC_MODEL.note.put(tx, input);

    assert.deepEqual(writes, [["note/note_1", note]]);
  });

  test("refuses an invalid write before set", async () => {
    let setCalls = 0;
    const tx: Pick<WriteTransaction, "set"> = {
      set: async () => {
        setCalls += 1;
      },
    };

    await assert.rejects(
      // @ts-expect-error exercise the runtime guard for an external invalid value
      SYNC_MODEL.note.put(tx, { ...note, rowVersion: "invalid" }),
    );
    assert.equal(setCalls, 0);
  });

  test("derives the delete key and hides the substrate result", async () => {
    const keys: string[] = [];
    const tx: Pick<WriteTransaction, "del"> = {
      del: async (key) => {
        keys.push(key);
        return true;
      },
    };

    assert.equal(await SYNC_MODEL.note.del(tx, { id: "note_1" }), undefined);
    assert.deepEqual(keys, ["note/note_1"]);
  });
});

describe("SYNC_MODEL pull parsing", () => {
  test("derives CVR identity and version from the parsed value", () => {
    const parsed = SYNC_MODEL.note.parsePullValue({
      id: "note_1",
      userId: "user_1",
      text: "Remember this",
      createdAt: "2026-08-29T00:00:00.000Z",
      rowVersion: 7,
    });

    assert.equal(parsed.id, "note_1");
    assert.equal(parsed.storageKey, "note/note_1");
    assert.equal(parsed.rowVersion, 7);
  });

  test("keeps the persisted wire schema strict", () => {
    assert.throws(() =>
      SYNC_MODEL.note.parsePullValue({
        id: "note_1",
        userId: "user_1",
        text: "Remember this",
        createdAt: new Date("2026-08-29T00:00:00.000Z"),
        rowVersion: 7,
      }),
    );
  });
});
