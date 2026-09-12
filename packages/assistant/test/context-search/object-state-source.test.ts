import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ObjectState, ObjectStateStore } from "@alfred/assistant/connections";
import { registerContextSource, searchContext } from "@alfred/assistant/context-search";

import { createObjectStateContextSource } from "../../src/context-search/object-state-source";

/**
 * Behavioral tests for the #425 object-state adapter.
 *
 * The adapter is driven through `searchContext`, so these also prove the
 * request's `objects` envelope parses, the card passes the canonical
 * `EvidenceCard` validation at the boundary, and a miss is reported as a card
 * rather than inferred closure. The store is a fake: the adapter is a mapping
 * over three reads, and a database is not required to prove the mapping.
 *
 * Each test installs and disposes its own instance; node's runner isolates test
 * files in separate processes, and the disposer runs in `finally`.
 */

type ObjectStateReader = Pick<ObjectStateStore, "resolveByKey" | "getState" | "getByIdentity">;

const SHA = "a1b2c3d4".repeat(5);

function objectState(overrides: Partial<ObjectState> = {}): ObjectState {
  return {
    objectId: "iobj_101",
    provider: "github",
    kind: "pull_request",
    externalId: "101",
    stateCategory: "active",
    nativeState: "open",
    title: "Fix the bug",
    url: "https://github.com/o/r/pull/101",
    repo: "o/r",
    stateDeliveredAt: new Date("2026-06-02T00:00:00Z"),
    ...overrides,
  };
}

function reader(overrides: Partial<ObjectStateReader> = {}): ObjectStateReader {
  return {
    async resolveByKey() {
      return null;
    },
    async getState() {
      return null;
    },
    async getByIdentity() {
      return null;
    },
    ...overrides,
  };
}

async function withObjectStateSource<T>(
  store: ObjectStateReader,
  run: () => Promise<T>,
): Promise<T> {
  const dispose = registerContextSource(createObjectStateContextSource(store));

  try {
    return await run();
  } finally {
    dispose();
  }
}

describe("object-state adapter — exact references", () => {
  test("resolves a key reference to a terminal card with object metadata", async () => {
    const store = reader({
      async resolveByKey() {
        return {
          objectId: "iobj_101",
          provider: "github",
          kind: "pull_request",
          externalId: "101",
        };
      },
      async getState() {
        return objectState({ stateCategory: "resolved", nativeState: "merged" });
      },
    });

    await withObjectStateSource(store, async () => {
      const result = await searchContext({
        userId: "user-1",
        query: "did the CI issue close?",
        objects: [{ by: "key", provider: "github", keyKind: "head_sha", keyValue: SHA }],
      });

      const card = result.evidence[0];
      assert.equal(result.sources[0]?.status, "ok");
      assert.ok(card);
      assert.equal(card.object?.stateCategory, "resolved");
      assert.equal(card.object?.nativeState, "merged");
      assert.equal(card.object?.provider, "github");
      assert.equal(card.object?.kind, "pull_request");
      assert.equal(card.object?.externalId, "101");
      assert.equal(card.object?.title, "Fix the bug");
      assert.equal(card.object?.url, "https://github.com/o/r/pull/101");
      assert.equal(card.object?.repo, "o/r");
      assert.equal(card.time?.freshness, "ingested");
      assert.equal(card.time?.observedAt, "2026-06-02T00:00:00.000Z");
      assert.equal(card.source.id, "object-state");
    });
  });

  test("resolves an identity reference to an active card", async () => {
    const store = reader({
      async getByIdentity() {
        return objectState();
      },
    });

    await withObjectStateSource(store, async () => {
      const result = await searchContext({
        userId: "user-1",
        query: "what is the state of PR 101?",
        objects: [{ by: "identity", provider: "github", kind: "pull_request", externalId: "101" }],
      });

      const card = result.evidence[0];
      assert.ok(card);
      assert.equal(card.object?.stateCategory, "active");
      assert.equal(card.object?.nativeState, "open");
      assert.equal(card.time?.freshness, "ingested");
    });
  });

  test("a key that resolves to a dropped row degrades without inventing state", async () => {
    const store = reader({
      async resolveByKey() {
        return { objectId: "iobj_gone", provider: "github", kind: "pull_request", externalId: "9" };
      },
      async getState() {
        return null;
      },
    });

    await withObjectStateSource(store, async () => {
      const result = await searchContext({
        userId: "user-1",
        query: "did it close?",
        objects: [{ by: "key", provider: "github", keyKind: "head_sha", keyValue: SHA }],
      });

      const card = result.evidence[0];
      assert.ok(card);
      assert.equal(card.object, undefined, "missing state must not be attributed an object");
      assert.equal(card.time?.freshness, "unknown");
      assert.ok(card.note);
    });
  });

  test("an unknown key is reported, never closed", async () => {
    const store = reader();

    await withObjectStateSource(store, async () => {
      const result = await searchContext({
        userId: "user-1",
        query: "did it close?",
        objects: [{ by: "key", provider: "github", keyKind: "head_sha", keyValue: SHA }],
      });

      const card = result.evidence[0];
      assert.ok(card);
      assert.equal(card.object, undefined);
      assert.equal(card.time?.freshness, "unknown");
      assert.ok(card.note);
    });
  });

  test("an unprojected provider degrades instead of indexing the registry", async () => {
    let resolved = false;

    const store = reader({
      async resolveByKey() {
        resolved = true;

        return null;
      },
    });

    await withObjectStateSource(store, async () => {
      const result = await searchContext({
        userId: "user-1",
        query: "anything",
        objects: [{ by: "key", provider: "clickup", keyKind: "task_id", keyValue: "T-1" }],
      });

      const card = result.evidence[0];
      assert.ok(card);
      assert.equal(card.object, undefined);
      assert.equal(resolved, false, "an unknown provider must not reach the store");
    });
  });

  test("a request with no exact references returns no evidence", async () => {
    const store = reader();

    await withObjectStateSource(store, async () => {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(result.evidence.length, 0);
      assert.equal(result.sources[0]?.status, "empty");
    });
  });
});
