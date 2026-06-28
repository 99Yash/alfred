import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  IDB_KEY,
  todoClearClient,
  todoCompleteClient,
  todoCompleteSuggestionClient,
  todoDismissClient,
  todoPromoteClient,
  todoReopenClient,
  type SyncedTodo,
} from "@alfred/sync";

import { serverMutators } from "../../src/modules/replicache/server-mutators";

// ---------------------------------------------------------------------------
// Todo lifecycle transitions (ADR-0050). Covers the two new transitions —
// clear (#297: done → cleared) and complete-from-suggested (#298: suggested →
// done) — plus the existing accept/dismiss/complete/reopen paths so the
// lifecycle does not regress.
// ---------------------------------------------------------------------------

type ClientTx = Parameters<typeof todoCompleteClient>[0];

function makeClientTx(initial: Record<string, unknown> = {}): {
  tx: ClientTx;
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>(Object.entries(initial));
  const tx = {
    async get(key: string): Promise<unknown> {
      return store.get(key);
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async has(key: string): Promise<boolean> {
      return store.has(key);
    },
    async del(key: string): Promise<void> {
      store.delete(key);
    },
  } as unknown as ClientTx;
  return { tx, store };
}

/** Server `update().set().where()` mock — todo mutators don't call `.returning()`. */
function makeUpdateTx(): {
  tx: unknown;
  calls: () => { setValue: Record<string, unknown> | undefined; whereCalled: boolean };
} {
  let setValue: Record<string, unknown> | undefined;
  let whereCalled = false;
  return {
    tx: {
      update(_table: unknown) {
        return {
          set(value: Record<string, unknown>) {
            setValue = value;
            return {
              where(_condition: unknown): Promise<void> {
                whereCalled = true;
                return Promise.resolve();
              },
            };
          },
        };
      },
    },
    calls: () => ({ setValue, whereCalled }),
  };
}

function todo(overrides: Partial<SyncedTodo> = {}): SyncedTodo {
  return {
    id: "todo_1",
    userId: "user_1",
    name: "Reply to Anna",
    description: null,
    status: "open",
    createdBy: "agent",
    executor: "user",
    kind: "task",
    assist: "She asked about the migration milestones",
    sources: [{ provider: "gmail", kind: "thread", id: "t1" }],
    agentRunId: null,
    completedAt: null,
    position: null,
    dueDate: null,
    rowVersion: 3,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

const KEY = IDB_KEY.TODO({ id: "todo_1" });

describe("todoClearClient (#297: done → cleared)", () => {
  test("deletes a done todo from the local store (cleared never syncs)", async () => {
    const { tx, store } = makeClientTx({
      [KEY]: todo({ status: "done", completedAt: "2026-06-21T00:00:00.000Z" }),
    });
    await todoClearClient(tx, { id: "todo_1" });
    assert.equal(store.has(KEY), false);
  });

  test("no-ops on a non-done todo (can't clear a live todo)", async () => {
    const { tx, store } = makeClientTx({ [KEY]: todo({ status: "open" }) });
    await todoClearClient(tx, { id: "todo_1" });
    assert.equal(store.has(KEY), true);
  });

  test("no-ops when the row is absent", async () => {
    const { tx, store } = makeClientTx();
    await todoClearClient(tx, { id: "todo_1" });
    assert.equal(store.size, 0);
  });
});

describe("todoCompleteSuggestionClient (#298: suggested → done)", () => {
  test("marks a suggestion done, stamps completedAt, and preserves provenance", async () => {
    const suggested = todo({ status: "suggested", createdBy: "agent" });
    const { tx, store } = makeClientTx({ [KEY]: suggested });

    await todoCompleteSuggestionClient(tx, { id: "todo_1" });

    const value = store.get(KEY) as SyncedTodo;
    assert.equal(value.status, "done");
    assert.equal(typeof value.completedAt, "string");
    assert.equal(value.rowVersion, suggested.rowVersion + 1);
    // Provenance rides along untouched (#298).
    assert.equal(value.createdBy, "agent");
    assert.equal(value.assist, suggested.assist);
    assert.deepEqual(value.sources, suggested.sources);
  });

  test("no-ops on a todo that is not suggested", async () => {
    const { tx, store } = makeClientTx({ [KEY]: todo({ status: "open" }) });
    await todoCompleteSuggestionClient(tx, { id: "todo_1" });
    assert.equal((store.get(KEY) as SyncedTodo).status, "open");
  });
});

describe("existing todo transitions still behave (no regression)", () => {
  test("todoComplete: open → done", async () => {
    const { tx, store } = makeClientTx({ [KEY]: todo({ status: "open" }) });
    await todoCompleteClient(tx, { id: "todo_1" });
    const value = store.get(KEY) as SyncedTodo;
    assert.equal(value.status, "done");
    assert.equal(typeof value.completedAt, "string");
  });

  test("todoReopen: done → open clears completedAt", async () => {
    const { tx, store } = makeClientTx({
      [KEY]: todo({ status: "done", completedAt: "2026-06-21T00:00:00.000Z" }),
    });
    await todoReopenClient(tx, { id: "todo_1" });
    const value = store.get(KEY) as SyncedTodo;
    assert.equal(value.status, "open");
    assert.equal(value.completedAt, null);
  });

  test("todoPromote: suggested → open preserves createdBy", async () => {
    const { tx, store } = makeClientTx({
      [KEY]: todo({ status: "suggested", createdBy: "agent" }),
    });
    await todoPromoteClient(tx, { id: "todo_1" });
    const value = store.get(KEY) as SyncedTodo;
    assert.equal(value.status, "open");
    assert.equal(value.createdBy, "agent");
  });

  test("todoDismiss: deletes the local row", async () => {
    const { tx, store } = makeClientTx({ [KEY]: todo({ status: "suggested" }) });
    await todoDismissClient(tx, { id: "todo_1" });
    assert.equal(store.has(KEY), false);
  });
});

describe("server mutators", () => {
  test("todoClear sets status=cleared and bumps the CVR version", async () => {
    const { tx, calls } = makeUpdateTx();
    await serverMutators.todoClear(tx, { id: "todo_1" }, { userId: "user_1" });
    const { setValue, whereCalled } = calls();
    assert.equal(setValue?.status, "cleared");
    assert.ok(setValue?.rowVersion);
    assert.equal(whereCalled, true);
  });

  test("todoCompleteSuggestion sets status=done with completedAt and bumps the version", async () => {
    const { tx, calls } = makeUpdateTx();
    await serverMutators.todoCompleteSuggestion(tx, { id: "todo_1" }, { userId: "user_1" });
    const { setValue, whereCalled } = calls();
    assert.equal(setValue?.status, "done");
    assert.ok(setValue?.completedAt instanceof Date);
    assert.ok(setValue?.rowVersion);
    assert.equal(whereCalled, true);
  });

  test("todoDismiss sets status=dismissed (regression)", async () => {
    const { tx, calls } = makeUpdateTx();
    await serverMutators.todoDismiss(tx, { id: "todo_1" }, { userId: "user_1" });
    assert.equal(calls().setValue?.status, "dismissed");
  });

  test("todoComplete sets status=done (regression)", async () => {
    const { tx, calls } = makeUpdateTx();
    await serverMutators.todoComplete(tx, { id: "todo_1" }, { userId: "user_1" });
    assert.equal(calls().setValue?.status, "done");
    assert.ok(calls().setValue?.completedAt instanceof Date);
  });
});
