import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mergeTodoSources, todoSourceKey, type TodoSource } from "@alfred/contracts";

import { todoSourcesOverlap } from "../../src/modules/todos/suggest";

// ---------------------------------------------------------------------------
// Phase 0 — the source-overlap merge that keeps `suggestTodo` idempotent.
//
// `suggestTodo` (modules/todos/suggest.ts) dedups a re-triaged thread against
// live todos: if any incoming `(provider, kind, id)` already references a live
// row, it merges the missing refs in instead of inserting a duplicate. That
// guard is built on `todoSourceKey` + `mergeTodoSources` from @alfred/contracts.
// Those primitives carry the idempotency contract, so we lock them here (the DB
// transaction itself has no test harness in this repo). The triage tail step
// writes one ref — `{ provider:'gmail', kind:'thread', id: sourceThreadId }` —
// so the same thread re-classified must merge to a no-op, never a second todo.
// ---------------------------------------------------------------------------

const threadRef: TodoSource = { provider: "gmail", kind: "thread", id: "thread_123" };

describe("todoSourceKey", () => {
  test("keys on (provider, kind, id) and ignores url", () => {
    assert.equal(
      todoSourceKey(threadRef),
      todoSourceKey({ ...threadRef, url: "https://mail.google.com/x" }),
    );
  });

  test("distinct ids produce distinct keys", () => {
    assert.notEqual(todoSourceKey(threadRef), todoSourceKey({ ...threadRef, id: "thread_456" }));
  });
});

describe("mergeTodoSources", () => {
  test("re-merging the same ref is a no-op (idempotent — the re-triage case)", () => {
    const merged = mergeTodoSources([threadRef], [threadRef]);
    assert.deepEqual(merged, [threadRef]);
    // The guard's "addedSources" is `merged.length - existing.length` → 0 here,
    // which is exactly what makes a re-triaged thread merge rather than dupe.
    assert.equal(merged.length - 1, 0);
  });

  test("a url-only difference still dedups (url is not part of identity)", () => {
    const merged = mergeTodoSources([threadRef], [{ ...threadRef, url: "https://x" }]);
    assert.equal(merged.length, 1);
  });

  test("a genuinely new ref appends, order-stable (existing first)", () => {
    const other: TodoSource = { provider: "slack", kind: "message", id: "m1" };
    const merged = mergeTodoSources([threadRef], [other]);
    assert.deepEqual(merged, [threadRef, other]);
  });

  test("mixed incoming: only the unseen ref is added", () => {
    const other: TodoSource = { provider: "slack", kind: "message", id: "m1" };
    const merged = mergeTodoSources([threadRef], [threadRef, other]);
    assert.deepEqual(merged, [threadRef, other]);
    assert.equal(merged.length - 1, 1); // addedSources == 1
  });
});

describe("todoSourcesOverlap (the REAL predicate suggestTodo's dedup loop runs)", () => {
  test("matches a live todo carrying the same thread ref → merge path", () => {
    assert.equal(todoSourcesOverlap([threadRef], [threadRef]), true);
  });

  test("does not match an unrelated todo → insert path", () => {
    assert.equal(
      todoSourcesOverlap([{ provider: "gmail", kind: "thread", id: "other" }], [threadRef]),
      false,
    );
  });

  test("matches on identity even when only the url differs (url is not identity)", () => {
    assert.equal(
      todoSourcesOverlap([{ ...threadRef, url: "https://mail.google.com/x" }], [threadRef]),
      true,
    );
  });

  test("empty existing or empty incoming never overlaps", () => {
    assert.equal(todoSourcesOverlap([], [threadRef]), false);
    assert.equal(todoSourcesOverlap([threadRef], []), false);
  });
});
