import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  advanceReplayState,
  createReplayStateController,
  replaySince,
  type ReplayState,
} from "../../src/lib/events/replay-state";

const emptyState = (): ReplayState => ({ cursor: 0, activeRuns: {} });

describe("event replay state", () => {
  test("a delta establishes a recovery barrier even when started was missed", () => {
    const state = advanceReplayState(emptyState(), {
      id: 42,
      kind: "chat.delta",
      payload: { runId: "run-1" },
    });

    assert.deepEqual(state, { cursor: 42, activeRuns: { "run-1": 41 } });
    assert.equal(replaySince(state), 41);
  });

  test("the cursor advances while an active run keeps its earlier barrier", () => {
    const active = advanceReplayState(emptyState(), {
      id: 42,
      kind: "chat.message",
      payload: { runId: "run-1", phase: "started" },
    });
    const later = advanceReplayState(active, {
      id: 80,
      kind: "inbox.updated",
      payload: {},
    });

    assert.equal(later.cursor, 80);
    assert.equal(replaySince(later), 41);
  });

  test("completion releases only its run and resumes from the monotonic cursor", () => {
    const state: ReplayState = {
      cursor: 80,
      activeRuns: { "run-1": 41, "run-2": 60 },
    };
    const completed = advanceReplayState(state, {
      id: 81,
      kind: "chat.message",
      payload: { runId: "run-1", phase: "completed" },
    });

    assert.deepEqual(completed, { cursor: 81, activeRuns: { "run-2": 60 } });
    assert.equal(replaySince(completed), 60);

    const idle = advanceReplayState(completed, {
      id: 82,
      kind: "chat.message",
      payload: { runId: "run-2", phase: "completed" },
    });
    assert.equal(replaySince(idle), 82);
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

    firstTab.noteFrame({ id: 100, kind: "inbox.updated", payload: {} });
    secondTab.noteFrame({ id: 75, kind: "inbox.updated", payload: {} });

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

    replay.noteFrame({
      id: 10,
      kind: "chat.message",
      payload: { runId: "run-1", phase: "started" },
    });
    for (let id = 11; id < 30; id += 1) {
      replay.noteFrame({ id, kind: "chat.delta", payload: { runId: "run-1" } });
    }
    assert.equal(writes, 1);

    replay.noteFrame({
      id: 30,
      kind: "chat.message",
      payload: { runId: "run-1", phase: "completed" },
    });
    assert.equal(writes, 2);
    assert.equal(stored.cursor, 30);
  });
});
