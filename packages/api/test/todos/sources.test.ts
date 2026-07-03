import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  boundTodoSources,
  gmailTodoSources,
  mergeTodoSources,
  TODO_SOURCES_MAX,
  todoSourceKey,
  type TodoSource,
} from "@alfred/contracts";

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

// ---------------------------------------------------------------------------
// #355 — dedup a recurring loop on its real-world entity key, not the Gmail
// thread. `gmailTodoSources` adds a stable `loop` ref alongside the transport
// `thread` ref; the same overlap guard above then collapses re-notifications
// (each arriving on a NEW thread) onto one todo. `boundTodoSources` keeps that
// merge from growing the row past the sync schema's max(64).
// ---------------------------------------------------------------------------

describe("gmailTodoSources", () => {
  test("carries only the thread ref when no loop key is derivable (human mail — v1 behavior)", () => {
    const sources = gmailTodoSources({
      threadId: "thread_1",
      subject: "Quick question about Q3 numbers",
      sender: "priya@client.com",
    });
    assert.deepEqual(sources, [{ provider: "gmail", kind: "thread", id: "thread_1" }]);
  });

  test("adds a stable loop ref for a GitHub PR notification", () => {
    const sources = gmailTodoSources({
      threadId: "thread_1",
      subject: "Re: [OlivAIRepo/baserow-middleware] Stop dictation harvest (PR #786)",
      sender: "notifications@github.com",
    });
    assert.deepEqual(sources, [
      { provider: "gmail", kind: "thread", id: "thread_1" },
      { provider: "github", kind: "pull_request", id: "olivairepo/baserow-middleware#786" },
    ]);
  });

  test("does not hard-dedup a GitHub-shaped subject without GitHub sender evidence", () => {
    const sources = gmailTodoSources({
      threadId: "thread_1",
      subject: "Re: [owner/repo] Planning doc review (PR #12)",
      sender: "Priya <priya@client.com>",
    });
    assert.deepEqual(sources, [{ provider: "gmail", kind: "thread", id: "thread_1" }]);
  });

  test("does not hard-dedup an issue-key subject without Linear/Jira sender evidence", () => {
    const sources = gmailTodoSources({
      threadId: "thread_1",
      subject: "ENG-123: interview loop feedback",
      sender: "Priya <priya@client.com>",
    });
    assert.deepEqual(sources, [{ provider: "gmail", kind: "thread", id: "thread_1" }]);
  });

  test("adds a tracker-scoped loop ref for a ClickUp task notification", () => {
    const sources = gmailTodoSources({
      threadId: "thread_1",
      subject: "Netsmart: Save view issues",
      sender: "ClickUp <notifications@tasks.clickup.com>",
    });
    assert.deepEqual(sources.at(-1), {
      provider: "clickup",
      kind: "subject",
      id: "netsmart: save view issues",
    });
  });

  test("two re-notifications on DISTINCT threads share the loop ref → overlap → merge (the fix)", () => {
    // Same PR, two emails, two Gmail threads. Today the thread ids differ so
    // the guard misses and a duplicate todo is minted; the loop ref collapses
    // them.
    const first = gmailTodoSources({
      threadId: "thread_A",
      subject: "Re: [owner/repo] Fix flaky test (PR #12)",
      sender: "notifications@github.com",
    });
    const second = gmailTodoSources({
      threadId: "thread_B",
      subject: "Re: [owner/repo] Fix flaky test (PR #12)",
      sender: "notifications@github.com",
    });
    assert.notEqual(first[0]?.id, second[0]?.id, "distinct transport threads");
    assert.equal(todoSourcesOverlap(first, second), true, "collapse via the loop ref");
  });

  test("distinct loops on distinct threads do NOT overlap (no false merge)", () => {
    const a = gmailTodoSources({
      threadId: "thread_A",
      subject: "Re: [owner/repo] Fix flaky test (PR #12)",
      sender: "notifications@github.com",
    });
    const b = gmailTodoSources({
      threadId: "thread_B",
      subject: "Re: [owner/repo] Add retries (PR #34)",
      sender: "notifications@github.com",
    });
    assert.equal(todoSourcesOverlap(a, b), false);
  });
});

describe("boundTodoSources", () => {
  const loopRef: TodoSource = { provider: "gmail", kind: "loop", id: "gh:owner/repo#1" };
  const slackRef: TodoSource = { provider: "slack", kind: "message", id: "m1" };
  const thread = (n: number): TodoSource => ({ provider: "gmail", kind: "thread", id: `t${n}` });

  test("under the cap is a no-op (same reference)", () => {
    const sources = [loopRef, thread(1), thread(2)];
    assert.equal(boundTodoSources(sources), sources);
  });

  test("evicts the OLDEST thread refs first, keeps identity refs + newest threads", () => {
    // loop + slack (identity-bearing, always kept) then 5 threads oldest→newest.
    const sources = [loopRef, slackRef, thread(1), thread(2), thread(3), thread(4), thread(5)];
    const bounded = boundTodoSources(sources, 4);
    assert.equal(bounded.length, 4);
    // Both identity refs survive; only the two newest threads remain.
    assert.deepEqual(bounded, [loopRef, slackRef, thread(4), thread(5)]);
  });

  test("keeps a sync-valid cap even when identity refs alone exceed it", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      provider: "slack",
      kind: "message",
      id: `m${i}`,
    })) satisfies TodoSource[];
    const bounded = boundTodoSources([...many, thread(1)], 4);
    // The public tool schema rejects this shape, but the lower-level write
    // helper still returns a sync-valid array by keeping the newest identity refs.
    assert.deepEqual(bounded, many.slice(2));
    assert.equal(bounded.length, 4);
  });

  test("a recurring loop stays bounded across many re-notifications", () => {
    // Simulate merge accretion: one loop ref + one fresh thread per notification.
    let acc: TodoSource[] = [];
    for (let i = 0; i < TODO_SOURCES_MAX + 40; i++) {
      acc = boundTodoSources(
        mergeTodoSources(
          acc,
          gmailTodoSources({
            threadId: `thread_${i}`,
            subject: "Re: [owner/repo] Long-lived PR (PR #7)",
            sender: "notifications@github.com",
          }),
        ),
      );
    }
    assert.ok(acc.length <= TODO_SOURCES_MAX, `bounded at ${acc.length}`);
    // The stable loop ref is retained, so future re-notifications still merge.
    assert.ok(
      acc.some(
        (s) => s.provider === "github" && s.kind === "pull_request" && s.id === "owner/repo#7",
      ),
    );
  });
});
