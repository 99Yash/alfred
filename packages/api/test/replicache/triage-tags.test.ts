import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { IDB_KEY, triageTagOverrideClient, type SyncedTriageTag } from "@alfred/sync";

import { serverMutators } from "../../src/modules/replicache/server-mutators";

type ClientTriageTagTx = Parameters<typeof triageTagOverrideClient>[0];

function makeClientTx(initial: Record<string, unknown> = {}): {
  tx: ClientTriageTagTx;
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
  } as unknown as ClientTriageTagTx;
  return { tx, store };
}

function makeUpdateTx(): {
  tx: unknown;
  calls: () => { setValue: unknown; whereCalled: boolean };
} {
  let setValue: unknown;
  let whereCalled = false;
  return {
    tx: {
      update(_table: unknown) {
        return {
          set(value: unknown) {
            setValue = value;
            return {
              async where(_condition: unknown): Promise<void> {
                whereCalled = true;
              },
            };
          },
        };
      },
    },
    calls: () => ({ setValue, whereCalled }),
  };
}

const baseTag = {
  threadId: "thread_1",
  userId: "user_1",
  category: "fyi",
  documentId: "doc_1",
  appliedLabelId: "label_fyi",
  rowVersion: 4,
  updatedAt: "2026-06-05T00:00:00.000Z",
} satisfies Omit<
  SyncedTriageTag,
  "source" | "confidence" | "rationale" | "classifiedAt" | "overriddenAt"
>;

describe("triageTagOverrideClient", () => {
  test("optimistically flips an auto tag to the user branch and drops classifier provenance", async () => {
    const key = IDB_KEY.TRIAGE_TAG({ id: baseTag.threadId });
    const autoTag: SyncedTriageTag = {
      source: "auto",
      confidence: 0.4,
      rationale: "low signal",
      classifiedAt: "2026-06-05T00:00:00.000Z",
      ...baseTag,
    };
    const { tx, store } = makeClientTx({ [key]: autoTag });

    await triageTagOverrideClient(tx, { threadId: baseTag.threadId, category: "urgent" });

    const value = store.get(key) as SyncedTriageTag;
    assert.equal(value.source, "user");
    assert.equal(value.category, "urgent");
    assert.equal(value.rowVersion, autoTag.rowVersion + 1);
    assert.equal(value.documentId, autoTag.documentId);
    assert.equal(value.appliedLabelId, null);
    assert.equal("confidence" in value, false);
    assert.equal("rationale" in value, false);
    assert.equal("classifiedAt" in value, false);
    assert.equal(Number.isNaN(Date.parse(value.overriddenAt)), false);
    assert.equal(value.updatedAt, value.overriddenAt);
  });

  test("no-ops when the thread has not synced a tag yet", async () => {
    const { tx, store } = makeClientTx();

    await triageTagOverrideClient(tx, { threadId: "missing", category: "urgent" });

    assert.equal(store.size, 0);
  });
});

describe("serverMutators.triageTagOverride", () => {
  test("sets the row to a user-authored tag and bumps the CVR version", async () => {
    const { tx, calls } = makeUpdateTx();

    await serverMutators.triageTagOverride(
      tx,
      { threadId: baseTag.threadId, category: "action_needed" },
      { userId: baseTag.userId },
    );

    const { setValue, whereCalled } = calls();
    const set = setValue as {
      category?: unknown;
      source?: unknown;
      overriddenAt?: unknown;
      appliedLabelId?: unknown;
      updatedAt?: unknown;
      rowVersion?: unknown;
    };
    assert.equal(set.category, "action_needed");
    assert.equal(set.source, "user");
    assert.ok(set.overriddenAt instanceof Date);
    assert.equal(set.appliedLabelId, null);
    assert.equal(set.updatedAt, set.overriddenAt);
    assert.ok(set.rowVersion);
    assert.equal(whereCalled, true);
  });
});
