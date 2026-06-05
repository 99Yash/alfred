import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mergeTodoSources, todoSourceKey, type TodoSource } from "@alfred/contracts";

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

describe("suggestTodo overlap guard (invariant the dedup loop relies on)", () => {
  // Mirrors the candidate-matching predicate in suggestTodo: an incoming source
  // set overlaps a candidate when any incoming key is already on the candidate.
  function overlaps(candidateSources: TodoSource[], incoming: TodoSource[]): boolean {
    const incomingKeys = new Set(incoming.map(todoSourceKey));
    return candidateSources.some((ref) => incomingKeys.has(todoSourceKey(ref)));
  }

  test("matches a live todo carrying the same thread ref → merge path", () => {
    assert.equal(overlaps([threadRef], [threadRef]), true);
  });

  test("does not match an unrelated todo → insert path", () => {
    assert.equal(
      overlaps([{ provider: "gmail", kind: "thread", id: "other" }], [threadRef]),
      false,
    );
  });
});
