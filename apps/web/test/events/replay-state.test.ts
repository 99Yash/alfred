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

const emptyState = (): ReplayState => ({ cursor: 0, activeRuns: {}, completedRuns: {} });

// One base payload per kind, so a test's premise cannot drift from its neighbours'.
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

const CHAT_REASONING: EventPayload<"chat.reasoning"> = {
  runId: "run-1",
  threadId: "thread-1",
  messageId: "msg-1",
  seq: 0,
  text: "thinking",
};

const CHAT_TOOL: EventPayload<"chat.tool"> = {
  runId: "run-1",
  threadId: "thread-1",
  messageId: "msg-1",
  toolCallId: "call-1",
  toolName: "system.fetch_url",
  status: "started",
  segmentIndex: 0,
};

const APPROVAL_REQUESTED: EventPayload<"approval.requested"> = {
  runId: "run-1",
  approvalId: "approval-1",
  approvalKind: "step",
  prompt: "Send the reply?",
};

const INBOX_UPDATED: EventPayload<"inbox.updated"> = { reason: "ingested" };

// The `SPEAKS_FOR_NO_RUN` kinds. The contract type forces `runId` where the payload has one.
const AGENT_RUN: EventPayload<"agent.run"> = { runId: "run-1", phase: "started" };

const AGENT_PROGRESS: EventPayload<"agent.progress"> = { runId: "run-1", step: "triage" };

const TOOL_CALL: EventPayload<"tool.call"> = {
  runId: "run-1",
  toolName: "gmail.poll_recent",
  status: "started",
};

const ARTIFACT_DELTA: EventPayload<"artifact.delta"> = {
  runId: "run-1",
  threadId: "thread-1",
  toolCallId: "call-1",
  seq: 0,
  text: "# draft",
  mode: "replace",
};

const MEMORY_FACT_LEARNED: EventPayload<"memory.fact_learned"> = {
  factId: "fact-1",
  key: "user.timezone",
  preview: "Asia/Kolkata",
  confidence: 1,
};

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

const artifactDelta = (
  id: number,
  payload: Partial<EventPayload<"artifact.delta">> = {},
): EventStreamFrame => ({
  id,
  createdAt: "",
  kind: "artifact.delta",
  payload: { ...ARTIFACT_DELTA, ...payload },
});

const inboxUpdated = (id: number): EventStreamFrame => ({
  id,
  createdAt: "",
  kind: "inbox.updated",
  payload: INBOX_UPDATED,
});

const approvalRequested = (
  id: number,
  payload: Partial<EventPayload<"approval.requested">> = {},
): EventStreamFrame => ({
  id,
  createdAt: "",
  kind: "approval.requested",
  payload: { ...APPROVAL_REQUESTED, ...payload },
});

const agentRun = (
  id: number,
  phase: EventPayload<"agent.run">["phase"],
  payload: Partial<EventPayload<"agent.run">> = {},
): EventStreamFrame => ({
  id,
  createdAt: "",
  kind: "agent.run",
  payload: { ...AGENT_RUN, ...payload, phase },
});

const excludedFrames = (id: number): readonly EventStreamFrame[] => [
  { id, createdAt: "", kind: "agent.run", payload: AGENT_RUN },
  { id, createdAt: "", kind: "agent.progress", payload: AGENT_PROGRESS },
  { id, createdAt: "", kind: "tool.call", payload: TOOL_CALL },
  { id, createdAt: "", kind: "artifact.delta", payload: ARTIFACT_DELTA },
  { id, createdAt: "", kind: "inbox.updated", payload: INBOX_UPDATED },
  { id, createdAt: "", kind: "memory.fact_learned", payload: MEMORY_FACT_LEARNED },
];

// The `SPEAKS_FOR_A_RUN` kinds, hand-listed. `case "chat.tool": return null` still compiles,
// so only these assertions catch a kind that stops arming.
const barrierFrames = (
  id: number,
): readonly { readonly frame: EventStreamFrame; readonly runId: string }[] => [
  { frame: chatMessage(id), runId: CHAT_MESSAGE.runId },
  {
    frame: { id, createdAt: "", kind: "chat.reasoning", payload: CHAT_REASONING },
    runId: CHAT_REASONING.runId,
  },
  { frame: chatDelta(id), runId: CHAT_DELTA.runId },
  { frame: { id, createdAt: "", kind: "chat.tool", payload: CHAT_TOOL }, runId: CHAT_TOOL.runId },
  {
    frame: { id, createdAt: "", kind: "approval.requested", payload: APPROVAL_REQUESTED },
    runId: APPROVAL_REQUESTED.runId,
  },
];

describe("event replay state", () => {
  test("a delta establishes a recovery barrier even when started was missed", () => {
    const state = advanceReplayState(emptyState(), chatDelta(42));

    assert.deepEqual(state, { cursor: 42, activeRuns: { "run-1": 41 }, completedRuns: {} });
    assert.equal(replaySince(state), 41);
  });

  // Hand-listed, so it covers today's `SPEAKS_FOR_NO_RUN` entries only. Some carry a `runId`.
  test("an excluded kind advances the cursor without arming a barrier", () => {
    for (const frame of excludedFrames(42)) {
      assert.deepEqual(
        advanceReplayState(emptyState(), frame),
        { cursor: 42, activeRuns: {}, completedRuns: {} },
        frame.kind,
      );
    }
  });

  test("a kind allowed to speak for a run arms that run's barrier", () => {
    for (const { frame, runId } of barrierFrames(42)) {
      assert.deepEqual(
        advanceReplayState(emptyState(), frame),
        { cursor: 42, activeRuns: { [runId]: 41 }, completedRuns: {} },
        frame.kind,
      );
    }
  });

  // Pins a known gap, not the desired behavior. A tab that joins a run mid-flight through
  // `artifact.delta` alone arms no barrier, so a reload loses those deltas.
  // The durable `artifacts` row heals it. Only the frame kind differs between the two cases.
  test("a mid-join artifact.delta floats the cursor past itself; a chat.delta does not", () => {
    const start: ReplayState = { cursor: 104, activeRuns: {}, completedRuns: {} };

    const afterArtifact = advanceReplayState(start, artifactDelta(105));
    assert.deepEqual(afterArtifact.activeRuns, {});
    assert.equal(replaySince(afterArtifact), 105);

    const afterChat = advanceReplayState(start, chatDelta(105));
    assert.deepEqual(afterChat.activeRuns, { [CHAT_DELTA.runId]: 104 });
    assert.equal(replaySince(afterChat), 104);
  });

  test("the cursor advances while an active run keeps its earlier barrier", () => {
    const active = advanceReplayState(emptyState(), chatMessage(42, { phase: "started" }));
    const later = advanceReplayState(active, inboxUpdated(80));

    assert.equal(later.cursor, 80);
    assert.equal(replaySince(later), 41);
  });

  test("compaction phases keep the run's existing barrier", () => {
    for (const phase of ["compaction_started", "compaction_finished"] as const) {
      const active = advanceReplayState(emptyState(), chatMessage(42, { phase: "started" }));
      const compacting = advanceReplayState(active, chatMessage(60, { phase }));

      assert.equal(compacting.activeRuns[CHAT_MESSAGE.runId], 41, phase);
      assert.equal(replaySince(compacting), 41, phase);
    }
  });

  test("completion releases only its run and resumes from the monotonic cursor", () => {
    const state: ReplayState = {
      cursor: 80,
      activeRuns: { "run-1": 41, "run-2": 60 },
      completedRuns: {},
    };

    const completed = advanceReplayState(
      state,
      chatMessage(81, { runId: "run-1", phase: "completed" }),
    );

    // 81 is above run-2's floor (60), so run-1 stays remembered against a later stray.
    assert.deepEqual(completed, {
      cursor: 81,
      activeRuns: { "run-2": 60 },
      completedRuns: { "run-1": 81 },
    });
    assert.equal(replaySince(completed), 60);

    const idle = advanceReplayState(
      completed,
      chatMessage(82, { runId: "run-2", phase: "completed" }),
    );

    assert.equal(replaySince(idle), 82);
  });

  // Replay resends old frames for every thread, so a completion behind the cursor is routine.
  // If it re-armed instead, every later reload would replay from an id that never advances.
  test("a completion replayed behind the cursor still releases its run", () => {
    const state: ReplayState = { cursor: 500, activeRuns: { "run-1": 41 }, completedRuns: {} };
    const replayed = advanceReplayState(state, chatMessage(42, { phase: "completed" }));

    // 42 is below the floor, so no stray can arrive and the prune drops the record.
    assert.deepEqual(replayed, { cursor: 500, activeRuns: {}, completedRuns: {} });
    assert.equal(replaySince(replayed), 500);
  });

  // A compile-time guard: fails if the frame widens to `unknown` or loses the kind-to-payload link.
  // `@ts-expect-error` cannot do this, because a read off `unknown` already errors.
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

  // A run publishes `completed` once, so a re-armed barrier would freeze `since` forever.
  test("a frame after a run's completion does not re-arm its barrier", () => {
    const started = advanceReplayState(emptyState(), chatMessage(10, { phase: "started" }));
    const delta = advanceReplayState(started, chatDelta(11, { seq: 0 }));
    const completed = advanceReplayState(delta, chatMessage(30, { phase: "completed" }));
    assert.deepEqual(completed.activeRuns, {});

    const stray = advanceReplayState(completed, chatDelta(31, { seq: 1 }));

    assert.deepEqual(stray.activeRuns, {});
    assert.equal(replaySince(stray), stray.cursor);
    assert.equal(replaySince(stray), 31);
  });

  // Sub-agent `chat.tool` frames carry the parent's `runId` and can arrive after the parent completes.
  test("a chat.tool naming an already-completed parent run does not re-arm it", () => {
    const started = advanceReplayState(emptyState(), chatMessage(10, { phase: "started" }));
    const completed = advanceReplayState(started, chatMessage(20, { phase: "completed" }));
    assert.deepEqual(completed.activeRuns, {});

    const republished = advanceReplayState(completed, {
      id: 21,
      createdAt: "",
      kind: "chat.tool",
      payload: CHAT_TOOL,
    });

    assert.deepEqual(republished.activeRuns, {});
    assert.equal(replaySince(republished), 21);
  });

  // The prune keeps `completedRuns[id] >= replaySince(next)`. An off-by-one is silent, so test both sides.
  test("a completion above the active floor is remembered; one below it is dropped", () => {
    const state: ReplayState = {
      cursor: 80,
      activeRuns: { "run-low": 5, "run-1": 41 },
      completedRuns: {},
    };

    const completed = advanceReplayState(
      state,
      chatMessage(81, { runId: "run-1", phase: "completed" }),
    );

    assert.equal(replaySince(completed), 5);
    assert.equal(completed.completedRuns["run-1"], 81);

    const stale: ReplayState = {
      cursor: 80,
      activeRuns: { "run-low": 5 },
      completedRuns: {},
    };

    const belowFloor = advanceReplayState(
      stale,
      chatMessage(3, { runId: "run-old", phase: "completed" }),
    );

    assert.equal(replaySince(belowFloor), 5);
    assert.equal(belowFloor.completedRuns["run-old"], undefined);
  });

  test("completedRuns drains to empty once the runs go idle", () => {
    const started = advanceReplayState(emptyState(), chatMessage(10, { phase: "started" }));
    const completed = advanceReplayState(started, chatMessage(30, { phase: "completed" }));
    assert.equal(completed.completedRuns["run-1"], 30);

    const idle = advanceReplayState(completed, inboxUpdated(900));
    assert.equal(idle.cursor, 900);
    assert.deepEqual(idle.completedRuns, {});
  });

  // Only `completedRuns` changes here. The write gate must still persist it, or a fresh tab re-arms on a stray.
  test("persists a completed run recorded while another run stays active", () => {
    let stored: ReplayState = {
      cursor: 80,
      activeRuns: { "run-2": 60 },
      completedRuns: {},
    };

    let writes = 0;

    const replay = createReplayStateController({
      read: () => stored,
      write: (state) => {
        stored = state;
        writes += 1;
      },
    });

    replay.noteFrame(chatMessage(81, { runId: "run-1", phase: "completed" }));

    assert.equal(writes, 1);
    assert.equal(stored.completedRuns["run-1"], 81);
    assert.deepEqual(stored.activeRuns, { "run-2": 60 });
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

  // A non-chat run never publishes `chat.message`, so `releasedRunId` must release on `agent.run`.
  // Without that, the barrier leaks and freezes `since` on every reload.
  test("an agent.run/completed releases a barrier its approval.requested armed", () => {
    const runId = APPROVAL_REQUESTED.runId;
    const armed = advanceReplayState(emptyState(), approvalRequested(70, { runId }));
    assert.deepEqual(armed.activeRuns, { [runId]: 69 });

    const released = advanceReplayState(armed, agentRun(80, "completed", { runId }));

    assert.deepEqual(released.activeRuns, {});
    assert.equal(released.completedRuns[runId], 80);
    assert.equal(replaySince(released), released.cursor);
    assert.equal(replaySince(released), 80);
  });

  // `blocked` is terminal in `RUN_STATUS_KIND`, so it releases too.
  test("agent.run/failed, cancelled and blocked also release the barrier", () => {
    for (const phase of ["failed", "cancelled", "blocked"] as const) {
      const runId = APPROVAL_REQUESTED.runId;
      const armed = advanceReplayState(emptyState(), approvalRequested(70, { runId }));
      assert.deepEqual(armed.activeRuns, { [runId]: 69 }, phase);

      const released = advanceReplayState(armed, agentRun(80, phase, { runId }));

      assert.deepEqual(released.activeRuns, {}, phase);
      assert.equal(released.completedRuns[runId], 80, phase);
      assert.equal(replaySince(released), 80, phase);
    }
  });

  // A release here would lose the in-flight run's replay.
  test("a non-terminal agent.run phase does not release the barrier", () => {
    for (const phase of [
      "started",
      "step_started",
      "step_completed",
      "interrupted",
      "resumed",
      "deferred",
    ] as const) {
      const runId = APPROVAL_REQUESTED.runId;
      const armed = advanceReplayState(emptyState(), approvalRequested(70, { runId }));
      const later = advanceReplayState(armed, agentRun(80, phase, { runId }));

      assert.deepEqual(later.activeRuns, { [runId]: 69 }, phase);
      assert.equal(replaySince(later), 69, phase);
    }
  });

  test("an approval.requested after an agent.run terminal does not re-arm the run", () => {
    const runId = APPROVAL_REQUESTED.runId;
    const armed = advanceReplayState(emptyState(), approvalRequested(70, { runId }));
    const released = advanceReplayState(armed, agentRun(80, "completed", { runId }));
    assert.deepEqual(released.activeRuns, {});

    const stray = advanceReplayState(released, approvalRequested(81, { runId }));

    assert.deepEqual(stray.activeRuns, {});
    assert.equal(replaySince(stray), stray.cursor);
    assert.equal(replaySince(stray), 81);
  });

  // `agent.run` stays in `SPEAKS_FOR_NO_RUN`: it can release a barrier but never arm one.
  test("an agent.run frame on its own never arms a barrier", () => {
    for (const phase of [
      "started",
      "step_completed",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      const state = advanceReplayState(emptyState(), agentRun(42, phase));

      assert.deepEqual(state.activeRuns, {}, phase);
      assert.equal(replaySince(state), 42, phase);
    }
  });

  test("a chat run releases on chat.message; a trailing agent.run terminal is a no-op", () => {
    const started = advanceReplayState(emptyState(), chatMessage(10, { phase: "started" }));
    const completed = advanceReplayState(started, chatMessage(30, { phase: "completed" }));
    assert.deepEqual(completed.activeRuns, {});
    assert.equal(completed.completedRuns[CHAT_MESSAGE.runId], 30);

    const trailing = advanceReplayState(
      completed,
      agentRun(31, "completed", { runId: CHAT_MESSAGE.runId }),
    );

    assert.deepEqual(trailing.activeRuns, {});
    assert.equal(replaySince(trailing), 31);
  });
});
