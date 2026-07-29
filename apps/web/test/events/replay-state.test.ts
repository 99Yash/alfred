import type { EventPayload } from "@alfred/contracts/events";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventStreamFrame } from "../../src/lib/events/frame";
import {
  advanceReplayState,
  createReplayStateController,
  replaySince,
  type ReplayState,
} from "../../src/lib/events/replay-state";

const emptyState = (): ReplayState => ({ cursor: 0, activeRuns: {} });

// One base payload per kind, spread with only the field a test is actually
// about. Hand-copied per-frame literals let one test's premise drift from its
// neighbours' —
// see .lessons/an-assertions-premise-needs-enforcing-not-typing.md.
const CHAT_MESSAGE: EventPayload<"chat.message"> = {
  runId: "run-1",
  threadId: "thread-1",
  messageId: "msg-1",
  phase: "started",
};

const CHAT_DELTA: EventPayload<"chat.delta"> = {
  runId: "run-1",
  threadId: "thread-1",
  messageId: "msg-1",
  seq: 0,
  text: "hello",
  segmentIndex: 0,
};

const INBOX_UPDATED: EventPayload<"inbox.updated"> = { reason: "ingested" };

const chatMessage = (
  id: number,
  payload: Partial<EventPayload<"chat.message">> = {},
): EventStreamFrame => ({
  id,
  createdAt: "",
  kind: "chat.message",
  payload: { ...CHAT_MESSAGE, ...payload },
});

const chatDelta = (
  id: number,
  payload: Partial<EventPayload<"chat.delta">> = {},
): EventStreamFrame => ({
  id,
  createdAt: "",
  kind: "chat.delta",
  payload: { ...CHAT_DELTA, ...payload },
});

const inboxUpdated = (id: number): EventStreamFrame => ({
  id,
  createdAt: "",
  kind: "inbox.updated",
  payload: INBOX_UPDATED,
});

describe("event replay state", () => {
  test("a delta establishes a recovery barrier even when started was missed", () => {
    const state = advanceReplayState(emptyState(), chatDelta(42));

    assert.deepEqual(state, { cursor: 42, activeRuns: { "run-1": 41 } });
    assert.equal(replaySince(state), 41);
  });

  test("the cursor advances while an active run keeps its earlier barrier", () => {
    const active = advanceReplayState(emptyState(), chatMessage(42, { phase: "started" }));
    const later = advanceReplayState(active, inboxUpdated(80));

    assert.equal(later.cursor, 80);
    assert.equal(replaySince(later), 41);
  });

  test("completion releases only its run and resumes from the monotonic cursor", () => {
    const state: ReplayState = {
      cursor: 80,
      activeRuns: { "run-1": 41, "run-2": 60 },
    };
    const completed = advanceReplayState(
      state,
      chatMessage(81, { runId: "run-1", phase: "completed" }),
    );

    assert.deepEqual(completed, { cursor: 81, activeRuns: { "run-2": 60 } });
    assert.equal(replaySince(completed), 60);

    const idle = advanceReplayState(
      completed,
      chatMessage(82, { runId: "run-2", phase: "completed" }),
    );
    assert.equal(replaySince(idle), 82);
  });

  // `/api/events` is user-scoped, and `?since` / `Last-Event-ID` resend historical
  // frames for every thread, so a terminal frame arriving *behind* the persisted
  // cursor is the routine reload shape rather than an edge case. If clearing ever
  // falls through to the arming branch, the barrier is re-armed and persisted to
  // localStorage and every later page load replays from an id that never advances.
  test("a completion replayed behind the cursor still releases its run", () => {
    const state: ReplayState = { cursor: 500, activeRuns: { "run-1": 41 } };
    const replayed = advanceReplayState(state, chatMessage(42, { phase: "completed" }));

    assert.deepEqual(replayed, { cursor: 500, activeRuns: {} });
    assert.equal(replaySince(replayed), 500);
  });

  // A compile-time guard riding a runtime test: this stops compiling if the frame
  // parameter re-widens to `unknown` *and* if it decorrelates to the union of every
  // kind's payload. `@ts-expect-error` cannot express that — reading a field off
  // `unknown` is itself an error, so the expect-error would stay satisfied and never
  // fire. The `assert` keeps `phase` alive against `noUnusedLocals`.
  test("the frame parameter keeps its payload narrowed to its kind", () => {
    const frame: Parameters<typeof advanceReplayState>[1] = chatMessage(81, {
      phase: "completed",
    });

    assert.equal(frame.kind, "chat.message");
    if (frame.kind === "chat.message") {
      const phase: EventPayload<"chat.message">["phase"] = frame.payload.phase;
      assert.equal(phase, "completed");
    }
  });

  test("controllers re-read shared storage so a stale tab cannot lower the cursor", () => {
    let stored = emptyState();
    const store = {
      read: () => stored,
      write: (state: ReplayState) => {
        stored = state;
      },
    };
    const firstTab = createReplayStateController(store);
    const secondTab = createReplayStateController(store);

    firstTab.noteFrame(inboxUpdated(100));
    secondTab.noteFrame(inboxUpdated(75));

    assert.equal(stored.cursor, 100);
  });

  test("does not write localStorage for every delta while a barrier is active", () => {
    let stored = emptyState();
    let writes = 0;
    const replay = createReplayStateController({
      read: () => stored,
      write: (state) => {
        stored = state;
        writes += 1;
      },
    });

    replay.noteFrame(chatMessage(10, { phase: "started" }));
    for (let id = 11; id < 30; id += 1) {
      replay.noteFrame(chatDelta(id, { seq: id - 11 }));
    }
    assert.equal(writes, 1);

    replay.noteFrame(chatMessage(30, { phase: "completed" }));
    assert.equal(writes, 2);
    assert.equal(stored.cursor, 30);
  });
});
