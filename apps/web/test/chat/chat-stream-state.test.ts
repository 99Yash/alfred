import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventPayload } from "@alfred/contracts/events";
import {
  applyChatFrame,
  applyOptimisticStop,
  createChatStreamCell,
  streamSnapshotsEqual,
  tickDrip,
  type ChatStreamCell,
  type StreamingMessage,
} from "../../src/lib/chat/chat-stream-state";
import type { EventStreamFrame } from "../../src/lib/events/frame";

/**
 * Every case drives the real reducer, and a turn is only ever mounted by a real
 * frame — there is no test-only door into the state. That is the point of the
 * split: the two invariants ADR-0073:21 names ("a sub-agent event may address an
 * in-flight turn but never create one"; "a terminal tool card is absorbing")
 * used to be comments over code reachable only from a browser.
 */

const THREAD = "thread_1";
const TURN = { threadId: THREAD, messageId: "msg_1", runId: "run_1" } as const;
const TURN_2 = { threadId: THREAD, messageId: "msg_2", runId: "run_2" } as const;
const SUB = { parentToolCallId: "spawn_1", subId: "sub_a", childRunId: "child_1" } as const;

type Turn = { threadId: string; messageId: string; runId: string };

const CREATED_AT = "2026-07-28T00:00:00.000Z";
let frameId = 0;
const nextId = () => (frameId += 1);

// Per-kind builders rather than one generic factory: a literal `kind` beside a
// payload of that kind's type is assignable to `EventStreamFrame` with no cast,
// so a schema change fails these builders instead of being silently unchecked.
const messageFrame = (payload: EventPayload<"chat.message">): EventStreamFrame => ({
  id: nextId(),
  kind: "chat.message",
  payload,
  createdAt: CREATED_AT,
});
const deltaFrame = (payload: EventPayload<"chat.delta">): EventStreamFrame => ({
  id: nextId(),
  kind: "chat.delta",
  payload,
  createdAt: CREATED_AT,
});
const reasoningFrame = (payload: EventPayload<"chat.reasoning">): EventStreamFrame => ({
  id: nextId(),
  kind: "chat.reasoning",
  payload,
  createdAt: CREATED_AT,
});
const toolFrame = (payload: EventPayload<"chat.tool">): EventStreamFrame => ({
  id: nextId(),
  kind: "chat.tool",
  payload,
  createdAt: CREATED_AT,
});
const runFrame = (payload: EventPayload<"agent.run">): EventStreamFrame => ({
  id: nextId(),
  kind: "agent.run",
  payload,
  createdAt: CREATED_AT,
});
const approvalFrame = (payload: EventPayload<"approval.requested">): EventStreamFrame => ({
  id: nextId(),
  kind: "approval.requested",
  payload,
  createdAt: CREATED_AT,
});

const started = (turn: Turn = TURN) => messageFrame({ ...turn, phase: "started" });
const completed = (turn: Turn = TURN) => messageFrame({ ...turn, phase: "completed" });
const compaction = (
  phase: "compaction_started" | "compaction_finished",
  turn: Turn = TURN,
): EventStreamFrame => messageFrame({ ...turn, phase });

const delta = (seq: number, text: string, opts: { segmentIndex?: number; turn?: Turn } = {}) =>
  deltaFrame({ ...(opts.turn ?? TURN), seq, text, segmentIndex: opts.segmentIndex ?? 0 });
const reasoning = (seq: number, text: string, turn: Turn = TURN) =>
  reasoningFrame({ ...turn, seq, text });

const tool = (
  args: {
    toolCallId?: string;
    toolName?: string;
    status?: "started" | "succeeded" | "failed";
    segmentIndex?: number;
    nonExecution?: boolean | undefined;
    resultPreview?: string | undefined;
    subAgent?: EventPayload<"chat.tool">["subAgent"];
    turn?: Turn;
  } = {},
) =>
  toolFrame({
    ...(args.turn ?? TURN),
    toolCallId: args.toolCallId ?? "tool_1",
    toolName: args.toolName ?? "gmail.search",
    status: args.status ?? "started",
    segmentIndex: args.segmentIndex ?? 0,
    nonExecution: args.nonExecution,
    resultPreview: args.resultPreview,
    subAgent: args.subAgent,
  });

const run = (runId: string, phase: EventPayload<"agent.run">["phase"]) =>
  runFrame({ runId, phase });
const approval = (runId: string) =>
  approvalFrame({ runId, approvalId: "appr_1", approvalKind: "step", prompt: "Send it?" });
/** A kind a chat turn does not read — the `default` arm the design keeps open. */
const unrelated = (): EventStreamFrame => ({
  id: nextId(),
  kind: "agent.progress",
  payload: { runId: "run_1", step: "triage" },
  createdAt: CREATED_AT,
});
/**
 * The one non-`chat.*` kind that *does* carry a `threadId`, and so is subject to
 * the hoisted thread check like any other — `frameThreadId` classifies by the
 * payload's field, not by the `chat.` name prefix. This reducer reads no arm for
 * it, so a matching-thread frame passes the check and is then dropped by the
 * bottom `return false`; the pair of cases below pins that as behaviour rather
 * than as prose.
 */
const artifactDelta = (threadId: string): EventStreamFrame => ({
  id: nextId(),
  kind: "artifact.delta",
  payload: {
    runId: "run_1",
    threadId,
    toolCallId: "tool_artifact",
    seq: 1,
    text: "# Draft",
    mode: "replace",
  },
  createdAt: CREATED_AT,
});

const cellOf = () => createChatStreamCell(THREAD);

/**
 * The cell's internals, for the assertions a projection cannot see (`deltaSeq`,
 * `stopped`, the trail maps). Production code never reaches through
 * `cell.current` — `tickDrip` hands back the projection and nothing else — so
 * this is the test's own door, not one the hook uses.
 */
function refOf(cell: ChatStreamCell) {
  const ref = cell.current;
  assert.ok(ref, "expected a mounted turn");
  return ref;
}

/** One animation frame, asserted to have found a mounted turn. */
function tick(cell: ChatStreamCell): { snapshot: StreamingMessage; caughtUp: boolean } {
  const projected = tickDrip(cell);
  assert.ok(projected, "expected a mounted turn");
  return projected;
}

/**
 * Drain the drip buffers to a settled projection. Every text assertion goes
 * through this: one `tickDrip` advances only a couple of chars, so asserting
 * full text after a single call would read as a reducer bug.
 */
function drain(cell: ChatStreamCell, bound = 500): { snapshot: StreamingMessage; ticks: number } {
  for (let i = 0; i < bound; i += 1) {
    const { snapshot, caughtUp } = tick(cell);
    if (caughtUp) return { snapshot, ticks: i + 1 };
  }
  throw new Error(`tickDrip did not reach caughtUp within ${bound} ticks`);
}

describe("applyChatFrame — mounting (ADR-0073: address, never create)", () => {
  test("a sub-agent frame against an empty cell mounts nothing", () => {
    const cell = cellOf();
    assert.equal(applyChatFrame(cell, tool({ subAgent: SUB }), 1_000), false);
    assert.equal(cell.current, null);
  });

  test("an agent.run and an approval against an empty cell mount nothing", () => {
    const cell = cellOf();
    assert.equal(applyChatFrame(cell, run("child_1", "completed"), 1_000), false);
    assert.equal(applyChatFrame(cell, approval("run_1"), 1_000), false);
    assert.equal(cell.current, null);
  });

  test("a child frame addressed to a finished turn leaves the live turn intact", () => {
    // The scenario that previously needed a browser and synthetic
    // `events_outbox` rows: a spawn outlives its parent turn, so a late child
    // frame can land while a completely different turn is streaming. Mounting
    // for it would blank turn 2's bubble and reset its delta seq.
    const cell = cellOf();
    applyChatFrame(cell, started(TURN), 1_000);
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "child_tool_1" }), 1_000);
    assert.equal(refOf(cell).subAgents.size, 1);

    applyChatFrame(cell, started(TURN_2), 1_000);
    assert.equal(applyChatFrame(cell, delta(1, "Hello", { turn: TURN_2 }), 1_000), true);

    const stale = tool({ subAgent: SUB, toolCallId: "child_tool_2", turn: TURN });
    assert.equal(applyChatFrame(cell, stale, 1_000), false);

    assert.equal(refOf(cell).messageId, "msg_2");
    assert.equal(refOf(cell).subAgents.size, 0);
    // The proof that `deltaSeq` was not reset: seq 2 still appends. If the stale
    // frame had mounted a fresh ref, deltaSeq would be 0 and this would pass for
    // the wrong reason — so assert the accumulated text, not just the return.
    assert.equal(applyChatFrame(cell, delta(2, " world", { turn: TURN_2 }), 1_000), true);
    assert.equal(drain(cell).snapshot.text, "Hello world");
  });

  test("a replayed `started` for the same turn does not clear what has arrived", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(3, "partial answer"), 1_000);
    applyChatFrame(cell, tool({ status: "succeeded" }), 1_000);

    assert.equal(applyChatFrame(cell, started(), 1_000), true);
    assert.equal(refOf(cell).deltaSeq, 3);
    assert.equal(refOf(cell).segments.get(0), "partial answer");
    assert.equal(refOf(cell).tools.size, 1);
  });

  test("a different runId for the same messageId mounts a fresh turn (a retry)", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(3, "first attempt"), 1_000);

    const retry = { threadId: THREAD, messageId: "msg_1", runId: "run_2" };
    assert.equal(applyChatFrame(cell, started(retry), 1_000), true);
    assert.equal(refOf(cell).deltaSeq, 0);
    assert.equal(refOf(cell).segments.size, 0);
  });

  test("a delta can mount the turn when `started` was missed", () => {
    // The `/chat` -> `/chat/<id>` navigation reopens the SSE stream and the bus
    // has no replay, so `started` can fire in the gap. Any frame carrying its
    // own (messageId, runId) may mount; the two kinds that carry no threadId
    // may not.
    const cell = cellOf();
    assert.equal(applyChatFrame(cell, delta(1, "hi"), 1_000), true);
    assert.equal(refOf(cell).messageId, "msg_1");
  });
});

describe("applyChatFrame — absorption (a terminal is absorbing)", () => {
  const withTrail = () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "child_tool_1" }), 1_000);
    return cell;
  };
  const trailOf = (cell: ChatStreamCell) => {
    const trail = refOf(cell).subAgents.get(SUB.parentToolCallId);
    assert.ok(trail, "expected a sub-agent trail");
    return trail;
  };

  test("a terminal trail outcome is never reopened", () => {
    const cell = withTrail();
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "completed"), 2_000), true);
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "failed"), 9_000), false);
    assert.deepEqual(
      { outcome: trailOf(cell).outcome, endedTs: trailOf(cell).endedTs },
      { outcome: "completed", endedTs: 2_000 },
    );
  });

  test("`interrupted` parks the trail and activity un-parks it", () => {
    const cell = withTrail();
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "interrupted"), 2_000), true);
    assert.deepEqual(
      { waiting: trailOf(cell).waiting, outcome: trailOf(cell).outcome },
      { waiting: true, outcome: null },
    );

    // Nothing publishes `resumed`; a resuming run emits `step_started`.
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "step_started"), 3_000), true);
    assert.equal(trailOf(cell).waiting, false);

    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "cancelled"), 4_000), true);
    assert.deepEqual(
      { waiting: trailOf(cell).waiting, outcome: trailOf(cell).outcome },
      { waiting: false, outcome: "cancelled" },
    );
  });

  test("an agent.run for an unmapped runId touches nothing", () => {
    const cell = withTrail();
    assert.equal(applyChatFrame(cell, run("run_unrelated", "completed"), 1_000), false);
    assert.equal(trailOf(cell).outcome, null);
  });

  test("a local stop freezes the reply and every later frame is dropped", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, reasoning(1, "thinking hard about it"), 1_000);
    applyChatFrame(cell, delta(1, "0123456789012345678901234567890123456789"), 1_100);

    // One tick, so `shown` is a strict prefix — the freeze has to be visible.
    const { snapshot: mid } = tick(cell);
    assert.ok(mid.text.length > 0 && mid.text.length < 40, `unexpected prefix: ${mid.text}`);

    assert.equal(applyOptimisticStop(cell), true);
    // The tick `stopStream` schedules right after the stop must already be
    // parked: a freeze that leaves easing work behind keeps typing post-click,
    // and `drain` alone would not notice.
    assert.equal(tick(cell).caughtUp, true);
    const frozen = drain(cell).snapshot;
    assert.equal(frozen.text, mid.text);
    assert.equal(frozen.reasoning, mid.reasoning);
    assert.equal(frozen.done, true);

    assert.equal(applyChatFrame(cell, delta(2, " and more"), 1_000), false);
    assert.equal(applyChatFrame(cell, reasoning(2, " and more"), 1_000), false);
    assert.equal(applyChatFrame(cell, tool({ toolCallId: "tool_late" }), 1_000), false);
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "completed"), 1_000), false);
    assert.equal(applyChatFrame(cell, approval("run_1"), 1_000), false);
    // …and the sixth kind, `chat.message`, in all three of its post-`started`
    // phases plus a replayed `started` for the same turn. `compaction_started`
    // is the one that was live: it flipped `compacting` on a frozen bubble,
    // which `conversation.tsx` relabels "Condensing conversation…" while
    // *suppressing* the thinking spinner, and un-parked the rAF loop for a tick.
    assert.equal(applyChatFrame(cell, compaction("compaction_started"), 1_000), false);
    // Read on the projection *immediately* after that frame, not at the end of
    // the block. `compacting` is on the snapshot and inside
    // `streamSnapshotsEqual`, so it is both the user-visible fact and the reason
    // a late flip re-renders — but `completed`'s own arm sets it back to `false`,
    // so an end-state check after the frames below passes on a leaking guard.
    assert.equal(drain(cell).snapshot.compacting, false);

    assert.equal(applyChatFrame(cell, compaction("compaction_finished"), 1_000), false);
    // `completed` additionally must not fire the `"completion_event"` mark, which
    // is the `summarize: true` one, for a turn the user cut short.
    assert.equal(applyChatFrame(cell, completed(), 1_000), false);
    assert.equal(applyChatFrame(cell, started(), 1_000), false);

    const after = drain(cell).snapshot;
    assert.equal(after.text, mid.text);
    assert.equal(after.tools.length, 0);
    assert.equal(after.done, true);
    assert.equal(after.compacting, false);
    assert.equal(refOf(cell).stopped, true);
  });

  test("a stop in the window after a segment-advancing delta freezes the live segment, not a prefix of it", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(1, "0123456789012345678901234567890123456789"), 1_000);

    // One tick, so `shown` is a strict prefix and `shownSegment` is 0.
    const { snapshot: mid } = tick(cell);
    assert.ok(mid.text.length > 0 && mid.text.length < 40, `unexpected prefix: ${mid.text}`);

    // The ~16ms window: a delta advances `currentSegment` and the user hits
    // stop before the next animation frame re-anchors the eased counter.
    applyChatFrame(cell, delta(2, "The full second segment of prose.", { segmentIndex: 1 }), 1_100);
    assert.equal(applyOptimisticStop(cell), true);

    const first = tick(cell);
    // Slicing segment 1 with segment 0's counter truncated it to `"The f"`,
    // which this tick then re-anchored and began easing out again as `"Th"`.
    assert.equal(first.snapshot.text, "");
    // …and re-anchoring without truncating would have eased the whole segment
    // out after the click, with `caughtUp` false the whole way.
    assert.equal(first.caughtUp, true);
    // Segment 0 was closed by the delta, not by the stop, so the projection
    // keeps it in full — the prose moved into `narration`, it was not dropped.
    // Reaching the screen is a separate question: `conversation.tsx:596`
    // renders the trail only when `stream.tools.length > 0`, so a stop on a
    // tool-less turn still leaves the user with a blank bubble.
    assert.deepEqual(first.snapshot.narration, [
      { index: 0, text: "0123456789012345678901234567890123456789" },
    ]);

    // The freeze is stable: no later tick reveals anything.
    assert.deepEqual(drain(cell).snapshot, first.snapshot);
  });

  test("a stop after the new segment has eased freezes it at its own prefix", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(1, "0123456789012345678901234567890123456789"), 1_000);
    tick(cell);

    applyChatFrame(cell, delta(2, "The full second segment of prose.", { segmentIndex: 1 }), 1_100);
    const { snapshot: mid } = tick(cell);
    assert.ok(
      mid.text.length > 0 && mid.text.length < 33,
      `expected a strict prefix of segment 1: ${mid.text}`,
    );
    assert.ok("The full second segment of prose.".startsWith(mid.text));

    assert.equal(applyOptimisticStop(cell), true);
    const first = tick(cell);
    assert.equal(first.snapshot.text, mid.text);
    assert.equal(first.caughtUp, true);
    assert.deepEqual(first.snapshot.narration, [
      { index: 0, text: "0123456789012345678901234567890123456789" },
    ]);
    assert.deepEqual(drain(cell).snapshot, first.snapshot);
  });

  test("a stop freezes only its own run — the next turn still mounts", () => {
    // `stopped` is checked on the ref the frame *names*, which is why the mount
    // happens first. Check it against whatever is currently in the cell instead
    // and the turn after a stop never renders at all.
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(1, "half an answer"), 1_000);
    applyOptimisticStop(cell);

    assert.equal(applyChatFrame(cell, delta(1, "a fresh turn", { turn: TURN_2 }), 1_000), true);
    assert.equal(refOf(cell).messageId, "msg_2");
    assert.equal(refOf(cell).stopped, false);
    assert.equal(drain(cell).snapshot.text, "a fresh turn");
  });

  test("a stop does not block the next turn's own chat.message/started", () => {
    // `chat.message`'s stop guard has to name the frame's own
    // `(messageId, runId)`, because `started` mounts the next turn over a
    // stopped ref. A blanket `if (cell.current?.stopped) return false` — or the
    // same check hoisted above the kind dispatch, next to the thread check,
    // which is exactly where it looks like it belongs — drops this frame and the
    // turn after any stop never renders. (The hoist would also strand a turn
    // opened by `chat.reasoning`, `chat.delta` or `chat.tool`, which mount the
    // same way.) This is the assertion that catches that.
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(1, "half an answer"), 1_000);
    applyOptimisticStop(cell);

    assert.equal(applyChatFrame(cell, started(TURN_2), 1_000), true);
    assert.equal(refOf(cell).messageId, "msg_2");
    assert.equal(refOf(cell).stopped, false);
    // And the replacing turn is fully live, not a husk: its own frames apply.
    assert.equal(applyChatFrame(cell, delta(1, "a fresh turn", { turn: TURN_2 }), 1_000), true);
    assert.equal(drain(cell).snapshot.text, "a fresh turn");
  });

  test("the stop guard is keyed on messageId AND runId, not on either one alone", () => {
    // Every other replacement-turn case here uses `TURN_2`, which differs from
    // `TURN` in *both* fields — so a guard that compares only one of them still
    // lets those cases pass. These two shapes differ in exactly one field each,
    // and each kills one half of the conjunction. Both are spread from `TURN` so
    // that "one field apart" is structural: hand-copying `TURN`'s literals here
    // would let an edit to `TURN` turn both of them back into differs-in-both
    // cases, silently reviving the two mutants this case exists to kill.
    //
    // Same messageId, new runId is the retry shape this file already pins for a
    // live turn ("a different runId for the same messageId mounts a fresh
    // turn"); dropping `runId` from the guard means a stopped turn can never be
    // retried.
    const retried = cellOf();
    applyChatFrame(retried, started(), 1_000);
    applyOptimisticStop(retried);
    const retry = { ...TURN, runId: "run_2" };
    assert.equal(applyChatFrame(retried, started(retry), 1_000), true);
    assert.equal(refOf(retried).runId, "run_2");
    assert.equal(refOf(retried).stopped, false);

    // New messageId, same runId. Nothing in production is known to emit this,
    // but the guard's `messageId` half is only load-bearing against it, so this
    // is what makes that half of the `&&` enforced rather than decorative.
    const remounted = cellOf();
    applyChatFrame(remounted, started(), 1_000);
    applyOptimisticStop(remounted);
    const sameRun = { ...TURN, messageId: "msg_9" };
    assert.equal(applyChatFrame(remounted, started(sameRun), 1_000), true);
    assert.equal(refOf(remounted).messageId, "msg_9");
    assert.equal(refOf(remounted).stopped, false);
  });

  test("a second stop, and a stop with nothing in flight, are no-ops", () => {
    assert.equal(applyOptimisticStop(cellOf()), false);
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    assert.equal(applyOptimisticStop(cell), true);
    assert.equal(applyOptimisticStop(cell), false);
  });
});

describe("applyChatFrame — monotonicity (clause 3)", () => {
  test("a stale delta seq is dropped without touching the text", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    assert.equal(applyChatFrame(cell, delta(3, "third"), 1_000), true);
    assert.equal(applyChatFrame(cell, delta(2, "second"), 1_000), false);
    assert.equal(refOf(cell).deltaSeq, 3);
    assert.equal(drain(cell).snapshot.text, "third");
  });

  test("a stale reasoning seq is dropped without touching the thinking", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    assert.equal(applyChatFrame(cell, reasoning(3, "third"), 1_000), true);
    assert.equal(applyChatFrame(cell, reasoning(2, "second"), 1_000), false);
    assert.equal(refOf(cell).reasoningSeq, 3);
    assert.equal(drain(cell).snapshot.reasoning, "third");
  });
});

describe("applyChatFrame — thread filter (the cell's own identity)", () => {
  const other: Turn = { threadId: "thread_other", messageId: "msg_x", runId: "run_x" };
  /** Every kind whose payload names a thread, in both shapes `chat.message` has. */
  const foreignFrames = (): EventStreamFrame[] => [
    started(other),
    completed(other),
    reasoning(1, "not ours", other),
    delta(1, "not ours", { turn: other }),
    tool({ turn: other }),
    tool({ turn: other, subAgent: SUB, toolCallId: "child_tool_x" }),
  ];

  test("against an empty cell, a foreign frame mounts nothing", () => {
    for (const frame of foreignFrames()) {
      const cell = cellOf();
      assert.equal(
        applyChatFrame(cell, frame, 1_000),
        false,
        `${frame.kind} leaked across threads`,
      );
      assert.equal(cell.current, null);
    }
  });

  test("against a live turn, a foreign frame leaves the projection byte-identical", () => {
    // The assertion a return-value check cannot make: a guard hoisted *below* a
    // mutation still returns false while having already written to the turn.
    for (const frame of foreignFrames()) {
      const cell = cellOf();
      applyChatFrame(cell, started(), 1_000);
      applyChatFrame(cell, reasoning(1, "thinking"), 1_000);
      applyChatFrame(cell, delta(1, "our own answer"), 1_100);
      applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "child_tool_1" }), 1_100);
      const before = drain(cell).snapshot;

      assert.equal(
        applyChatFrame(cell, frame, 9_000),
        false,
        `${frame.kind} leaked across threads`,
      );

      assert.deepEqual(drain(cell).snapshot, before, `${frame.kind} mutated another thread's turn`);
    }
  });

  test("the two kinds that name no thread still cannot mount a turn", () => {
    // ADR-0073's shape: `agent.run` and `approval.requested` carry no `threadId`
    // at all, so they pass the hoisted guard — and must then resolve only
    // against a ref that already exists.
    const cell = cellOf();
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "completed"), 1_000), false);
    assert.equal(applyChatFrame(cell, approval("run_1"), 1_000), false);
    assert.equal(cell.current, null);
  });

  test("a kind this reducer reads no arm for is dropped whether or not its thread matches", () => {
    // `artifact.delta` is thread-scoped and gated above the dispatch; with no arm
    // to reach, it then falls out of the bottom `return false`. `agent.progress`
    // names no thread, passes the check, and falls out the same way — so the
    // `default: null` arm of the thread reader has not started admitting anything.
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    const before = drain(cell).snapshot;
    for (const threadId of [THREAD, "thread_other"]) {
      assert.equal(applyChatFrame(cell, artifactDelta(threadId), 1_000), false);
      assert.equal(applyChatFrame(cell, unrelated(), 1_000), false);
    }
    assert.deepEqual(drain(cell).snapshot, before);
  });
});

describe("SubAgentTrail — identity is write-once", () => {
  test("a second child under one parent call keeps the first child's identity", () => {
    // The dependency `streamSnapshotsEqual` rests on, made executable. The
    // server spawns exactly one child per `(parentRunId, parentToolCallId)`
    // (`packages/api/src/modules/agent/sub-agents.ts` — `findExistingSubAgentRun`
    // plus the sub-agent `dedupKey` unique index), so this case cannot happen in
    // production. If it ever could, this is what the client would do: keep the
    // first `subId`/`childRunId`, absorb the second child's calls into that
    // trail, and report the two projections *equal* because neither field is
    // compared. Pinning it means a change to either half is a red test rather
    // than a silent merge.
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "child_tool_1" }), 1_000);
    const before = drain(cell).snapshot;

    const impostor = {
      parentToolCallId: SUB.parentToolCallId,
      subId: "sub_b",
      childRunId: "child_2",
    };
    assert.equal(
      applyChatFrame(cell, tool({ subAgent: impostor, toolCallId: "child_tool_2" }), 2_000),
      true,
    );

    const trail = refOf(cell).subAgents.get(SUB.parentToolCallId);
    assert.ok(trail);
    assert.deepEqual(
      { subId: trail.subId, childRunId: trail.childRunId, startedTs: trail.startedTs },
      { subId: SUB.subId, childRunId: SUB.childRunId, startedTs: 1_000 },
    );
    // …and the comparison the animation loop runs cannot tell them apart on
    // identity alone. It reports unequal here only because a tool card was
    // added; drop that card and the two snapshots compare equal.
    const after = drain(cell).snapshot;
    assert.equal(streamSnapshotsEqual(before, after), false);
    assert.deepEqual(
      after.subAgents[0]?.tools.map((t) => t.toolCallId),
      ["child_tool_1", "child_tool_2"],
    );
    assert.equal(
      streamSnapshotsEqual(before, {
        ...after,
        subAgents: after.subAgents.map((t) => ({ ...t, tools: t.tools.slice(0, 1) })),
      }),
      true,
      "subId / childRunId / startedTs are deliberately not compared",
    );
  });
});

describe("applyChatFrame — reasoningMs", () => {
  test("freezes at the first delta and does not move again", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, reasoning(1, "thinking"), 1_000);
    applyChatFrame(cell, delta(1, "answer"), 1_250);
    assert.equal(refOf(cell).reasoningMs, 250);

    applyChatFrame(cell, reasoning(2, " more"), 5_000);
    applyChatFrame(cell, delta(2, " more"), 6_000);
    assert.equal(refOf(cell).reasoningMs, 250);
  });

  test("stays null when no reasoning ever arrived", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(1, "answer"), 1_250);
    assert.equal(drain(cell).snapshot.reasoningMs, null);
  });
});

describe("applyChatFrame — return value per branch", () => {
  // The one thing a state-only assertion cannot see. On `main` these branches
  // were `ensureRaf()` calls and bare `return`s inside one closure; a branch
  // translated the wrong way stops the bubble typing until the next frame
  // lands, with nothing failing. Table derived from `main` by inspection before
  // any code moved (see the item file's branch table).
  const mounted = () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    return cell;
  };

  test("chat.message", () => {
    const cell = mounted();
    assert.equal(applyChatFrame(cell, compaction("compaction_started"), 1_000), true);
    assert.equal(refOf(cell).compacting, true);
    assert.equal(applyChatFrame(cell, compaction("compaction_finished"), 1_000), true);
    assert.equal(refOf(cell).compacting, false);
    // A compaction or completion phase naming a turn we do not hold changes
    // nothing, so it must not schedule a frame.
    assert.equal(applyChatFrame(cell, compaction("compaction_started", TURN_2), 1_000), false);
    assert.equal(applyChatFrame(cell, completed(TURN_2), 1_000), false);
    assert.equal(applyChatFrame(cell, completed(), 1_000), true);
    assert.equal(refOf(cell).done, true);
  });

  test("chat.tool — sub-agent arm", () => {
    const cell = mounted();
    // A bounce with no trail to retract draws nothing, so it must not tick.
    assert.equal(
      applyChatFrame(cell, tool({ subAgent: SUB, nonExecution: true }), 1_000),
      false,
      "an empty sub-agent container is worse than silence",
    );
    assert.equal(refOf(cell).subAgents.size, 0);

    assert.equal(applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "ct_1" }), 1_000), true);
    // With a trail present, a bounce does retract and must re-project.
    assert.equal(
      applyChatFrame(
        cell,
        tool({ subAgent: SUB, toolCallId: "ct_1", status: "failed", nonExecution: true }),
        1_000,
      ),
      true,
    );
  });

  test("chat.tool — the boss's own calls", () => {
    const cell = mounted();
    assert.equal(applyChatFrame(cell, tool({ toolCallId: "t_1" }), 1_000), true);
    assert.equal(
      applyChatFrame(cell, tool({ toolCallId: "t_1", status: "succeeded" }), 1_000),
      true,
    );
    // A retraction mutates the trail even though it records no timing mark.
    assert.equal(
      applyChatFrame(
        cell,
        tool({ toolCallId: "t_1", status: "failed", nonExecution: true }),
        1_000,
      ),
      true,
    );
    assert.equal(refOf(cell).tools.size, 0);
  });

  test("agent.run — a non-terminal phase for a trail that was never parked", () => {
    const cell = mounted();
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "ct_1" }), 1_000);
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "step_started"), 1_000), false);
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "step_completed"), 1_000), false);
  });

  test("approval.requested", () => {
    const cell = mounted();
    assert.equal(applyChatFrame(cell, approval("run_other"), 1_000), false);
    assert.equal(refOf(cell).awaitingApproval, false);
    assert.equal(applyChatFrame(cell, approval("run_1"), 1_000), true);
    assert.equal(refOf(cell).awaitingApproval, true);
    // `completed` clears the wait, so it still has to re-project.
    assert.equal(applyChatFrame(cell, completed(), 1_000), true);
    assert.equal(refOf(cell).awaitingApproval, false);
  });

  test("a kind the chat turn does not read", () => {
    const cell = mounted();
    assert.equal(applyChatFrame(cell, unrelated(), 1_000), false);
  });
});

describe("tickDrip", () => {
  test("terminates, and never shows more than has been received", () => {
    const cell = cellOf();
    const answer = "The quick brown fox jumps over the lazy dog, twice, for luck.";
    const thinking = "Checking the calendar first.";
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, reasoning(1, thinking), 1_000);
    applyChatFrame(cell, delta(1, answer), 1_000);

    let previous = 0;
    let ticks = 0;
    for (;;) {
      ticks += 1;
      assert.ok(ticks <= 500, "tickDrip did not converge");
      const { snapshot, caughtUp } = tick(cell);
      assert.ok(snapshot.text.length >= previous, "shown text went backwards");
      assert.ok(answer.startsWith(snapshot.text), "shown text is not a prefix of what arrived");
      assert.ok(thinking.startsWith(snapshot.reasoning), "shown reasoning is not a prefix");
      previous = snapshot.text.length;
      // `caughtUp` is true exactly when both eased counters have arrived.
      assert.equal(
        caughtUp,
        snapshot.text === answer && snapshot.reasoning === thinking,
        `caughtUp disagreed with the buffers at tick ${ticks}`,
      );
      if (caughtUp) break;
    }
    assert.ok(ticks > 1, "a single tick should not drain 61 chars — the easing is the point");
  });

  test("a closed segment moves to narration and the new one eases in from its own start", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(1, "Looking that up.", { segmentIndex: 0 }), 1_000);
    applyChatFrame(cell, delta(2, "   ", { segmentIndex: 1 }), 1_000);
    applyChatFrame(cell, delta(3, "Here it is.", { segmentIndex: 2 }), 1_000);

    const { snapshot } = drain(cell);
    // Segment 1 is blank, so it is not a narration line; segment 2 is the reply.
    assert.deepEqual(snapshot.narration, [{ index: 0, text: "Looking that up." }]);
    assert.equal(snapshot.text, "Here it is.");
  });

  test("the segment counter resets before the projection, not after", () => {
    // The ordering that was a comment inside the rAF closure. Drain a long
    // segment 0 first, so `shown` is larger than segment 1's whole length: with
    // the reset, segment 1 eases in from its own first char; without it, `ease`
    // sees shown > full, no-ops, and the new segment pops in whole. Asserting
    // only "is a prefix" cannot tell those apart — the pop-in is also a prefix.
    const second = "Second segment.";
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(
      cell,
      delta(1, "A long first narration segment here, comfortably longer.", {
        segmentIndex: 0,
      }),
      1_000,
    );
    drain(cell);
    applyChatFrame(cell, delta(2, second, { segmentIndex: 1 }), 1_000);

    const { snapshot } = tick(cell);
    assert.ok(second.startsWith(snapshot.text), `eased in from the wrong offset: ${snapshot.text}`);
    assert.ok(snapshot.text.length > 0, "the new segment should start rendering immediately");
    assert.ok(
      snapshot.text.length < second.length,
      `segment 1 popped in whole instead of easing: ${snapshot.text}`,
    );
  });
});

describe("streamSnapshotsEqual", () => {
  const streamingTurn = () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), 1_000);
    applyChatFrame(cell, delta(1, "done"), 1_000);
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "ct_1" }), 1_000);
    return cell;
  };

  test("a settled projection compares equal to itself", () => {
    const cell = streamingTurn();
    const first = drain(cell).snapshot;
    const { snapshot: second } = tick(cell);
    assert.equal(streamSnapshotsEqual(first, second), true);
  });

  test("a trail's `waiting` flip alone is not equal", () => {
    const cell = streamingTurn();
    const before = drain(cell).snapshot;
    applyChatFrame(cell, run(SUB.childRunId, "interrupted"), 2_000);
    const after = drain(cell).snapshot;
    assert.equal(
      streamSnapshotsEqual(before, after),
      false,
      "a parked child must re-render — the trail headline and the spinner both change",
    );
  });

  test("no previous snapshot is never equal", () => {
    const cell = streamingTurn();
    assert.equal(streamSnapshotsEqual(null, drain(cell).snapshot), false);
  });
});
