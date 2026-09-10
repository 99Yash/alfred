import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CONTEXT_SEARCH_DEFAULT_LIMIT,
  CONTEXT_SEARCH_MAX_LIMIT,
  contextSearchRequestSchema,
  listContextSources,
  registerContextSource,
  searchContext,
  type ContextEvidence,
  type ContextSource,
} from "../src/context-fabric";

/**
 * #422 boundary behaviour: the envelope is validated at the owning boundary and
 * the no-adapter path returns an empty, typed result instead of throwing.
 */

function evidence(overrides: Partial<ContextEvidence> = {}): ContextEvidence {
  return {
    id: "ev-1",
    sourceId: "fixture",
    mediaType: "text",
    snippet: "a bounded preview",
    score: 0.9,
    ...overrides,
  };
}

describe("contextSearchRequestSchema", () => {
  test("applies the default limit and trims the query", () => {
    const parsed = contextSearchRequestSchema.parse({
      userId: "usr_1",
      query: "  deploy status  ",
    });

    assert.equal(parsed.query, "deploy status");
    assert.equal(parsed.limit, CONTEXT_SEARCH_DEFAULT_LIMIT);
  });

  test("rejects a missing user, a blank query, and an out-of-range limit", () => {
    assert.equal(contextSearchRequestSchema.safeParse({ query: "x" }).success, false);
    assert.equal(
      contextSearchRequestSchema.safeParse({ userId: "usr_1", query: "   " }).success,
      false,
    );
    assert.equal(
      contextSearchRequestSchema.safeParse({
        userId: "usr_1",
        query: "x",
        limit: CONTEXT_SEARCH_MAX_LIMIT + 1,
      }).success,
      false,
    );
    assert.equal(
      contextSearchRequestSchema.safeParse({ userId: "usr_1", query: "x", limit: 1.5 }).success,
      false,
    );
  });
});

describe("searchContext", () => {
  test("returns an empty typed result when no source is registered", async () => {
    assert.deepEqual(listContextSources(), []);

    const result = await searchContext({ userId: "usr_1", query: "what changed overnight" });

    assert.deepEqual(result, {
      request: { userId: "usr_1", query: "what changed overnight", limit: 10 },
      evidence: [],
      sources: [],
    });
  });

  test("surfaces registered evidence and reports a failing source without sinking the read", async () => {
    const good: ContextSource = {
      id: "good",
      search: async () => ({ evidence: [evidence({ id: "a" }), evidence({ id: "b" })] }),
    };

    const broken: ContextSource = {
      id: "broken",
      search: async () => {
        throw new Error("provider refused the read");
      },
    };

    const disposeGood = registerContextSource(good);
    const disposeBroken = registerContextSource(broken);

    try {
      const result = await searchContext({ userId: "usr_1", query: "anything", limit: 1 });

      assert.deepEqual(
        result.evidence.map((card) => card.id),
        ["a"],
      );
      assert.deepEqual(result.sources, [
        { sourceId: "good", status: "ok", evidenceCount: 2 },
        {
          sourceId: "broken",
          status: "error",
          evidenceCount: 0,
          reason: "provider refused the read",
        },
      ]);
    } finally {
      disposeGood();
      disposeBroken();
    }

    assert.deepEqual(listContextSources(), []);
  });

  test("refuses a duplicate source id but tolerates re-installing the same instance", () => {
    const first: ContextSource = { id: "dup", search: async () => ({ evidence: [] }) };
    const second: ContextSource = { id: "dup", search: async () => ({ evidence: [] }) };

    const dispose = registerContextSource(first);

    try {
      assert.doesNotThrow(() => registerContextSource(first));
      assert.throws(() => registerContextSource(second), /already registered/);
    } finally {
      dispose();
    }

    assert.deepEqual(listContextSources(), []);
  });
});
