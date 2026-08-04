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

// The kinds `SPEAKS_FOR_NO_RUN` names. Typed as `EventPayload<K>` so a kind whose
// payload is run-scoped carries a `runId` because the contract requires it, not
// because a literal was hand-copied — that `runId` is the premise the exclusion
// assertion rests on.
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

const inboxUpdated = (id: number): EventStreamFrame => ({
  id,
  createdAt: "",
  kind: "inbox.updated",
  payload: INBOX_UPDATED,
});

const excludedFrames = (id: number): readonly EventStreamFrame[] => [
  { id, createdAt: "", kind: "agent.run", payload: AGENT_RUN },
  { id, createdAt: "", kind: "agent.progress", payload: AGENT_PROGRESS },
  { id, createdAt: "", kind: "tool.call", payload: TOOL_CALL },
  { id, createdAt: "", kind: "artifact.delta", payload: ARTIFACT_DELTA },
  { id, createdAt: "", kind: "inbox.updated", payload: INBOX_UPDATED },
  { id, createdAt: "", kind: "memory.fact_learned", payload: MEMORY_FACT_LEARNED },
];

// The kinds `SPEAKS_FOR_A_RUN` names, hand-listed. Membership in that table compels
// no `switch` arm to arm a barrier — `case "chat.tool": return null` retires a
// named kind and still compiles — so these assertions are the only cover for
// that direction, at tier 4, and nothing makes the list track the table. Each
// expected run id is read off its own fixture rather than re-typed, so the
// assertion cannot drift from its premise
// (.lessons/an-assertions-premise-needs-enforcing-not-typing.md).
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

  // The kinds `SPEAKS_FOR_NO_RUN` names today: each advances the cursor and arms
  // nothing. Some of them carry a `runId` their typed payload requires, so this
  // is the exclusion policy and not a statement about which payloads have the
  // field. Hand-listed like `barrierFrames` — nothing makes it track the
  // table, so it covers the entries present today and not future ones.
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

    // run-1's completion at 81 sits above the floor run-2 (60) holds, so it is
    // remembered against a later stray. run-2 is untouched.
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

  // `/api/events` is user-scoped, and `?since` / `Last-Event-ID` resend historical
  // frames for every thread, so a terminal frame arriving *behind* the persisted
  // cursor is the routine reload shape rather than an edge case. If clearing ever
  // falls through to the arming branch, the barrier is re-armed and persisted to
  // localStorage and every later page load replays from an id that never advances.
  test("a completion replayed behind the cursor still releases its run", () => {
    const state: ReplayState = { cursor: 500, activeRuns: { "run-1": 41 }, completedRuns: {} };
    const replayed = advanceReplayState(state, chatMessage(42, { phase: "completed" }));

    // The completion at 42 is below the floor (500), so the prune drops its
    // terminal record: replay never resends an id at or below the cursor, so no
    // stray for this run can arrive to be rejected.
    assert.deepEqual(replayed, { cursor: 500, activeRuns: {}, completedRuns: {} });
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

  // The probe from item 31 review r1 must-fix 3: a recoverable frame that merely
  // *names* a run whose `completed` was already applied must not re-arm that run's
  // barrier. The clearing branch is id-tolerant (a completion releases under any
  // arrival order); the arming branch must refuse a run recorded as terminal, or
  // `since` freezes at the stray's barrier forever because a run publishes
  // `completed` at most once.
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

  // Sub-agent `chat.tool` frames carry the *parent's* `runId`, and `dispatchBatch`
  // republishes non-terminal frames on every resume and stale-lease reclaim, so a
  // `chat.tool` naming an already-completed parent run is an ordinary occurrence.
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

  // The prune floor is `completedRuns[id] < replaySince(next)`, strictly below.
  // A run that completes *above* the floor another active run holds must stay
  // remembered so its own strays are still rejected; a completion at or below the
  // floor is dropped. An off-by-one here is silent, so assert both directions.
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

    // `run-low` holds the floor at 5; run-1's completion at 81 sits above it.
    assert.equal(replaySince(completed), 5);
    assert.equal(completed.completedRuns["run-1"], 81);

    // A stale completion behind the floor is dropped by the prune.
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
