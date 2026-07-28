import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventPayload } from "@alfred/contracts/events";
import {
  applyChatFrame,
  applyOptimisticStop,
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

const ctx = (now = 1_000) => ({ threadId: THREAD, now });
const cellOf = (): ChatStreamCell => ({ current: null });

/**
 * `tickDrip` takes the ref, not the cell — deliberately, so the only way to a
 * `StreamingMessage` is through the easing step. Tests reach it the same way the
 * hook does: null-check the cell.
 */
function refOf(cell: ChatStreamCell) {
  const ref = cell.current;
  assert.ok(ref, "expected a mounted turn");
  return ref;
}

/**
 * Drain the drip buffers to a settled projection. Every text assertion goes
 * through this: one `tickDrip` advances only a couple of chars, so asserting
 * full text after a single call would read as a reducer bug.
 */
function drain(cell: ChatStreamCell, bound = 500): { snapshot: StreamingMessage; ticks: number } {
  const ref = refOf(cell);
  for (let i = 0; i < bound; i += 1) {
    const { snapshot, caughtUp } = tickDrip(ref);
    if (caughtUp) return { snapshot, ticks: i + 1 };
  }
  throw new Error(`tickDrip did not reach caughtUp within ${bound} ticks`);
}

describe("applyChatFrame — mounting (ADR-0073: address, never create)", () => {
  test("a sub-agent frame against an empty cell mounts nothing", () => {
    const cell = cellOf();
    assert.equal(applyChatFrame(cell, tool({ subAgent: SUB }), ctx()), false);
    assert.equal(cell.current, null);
  });

  test("an agent.run and an approval against an empty cell mount nothing", () => {
    const cell = cellOf();
    assert.equal(applyChatFrame(cell, run("child_1", "completed"), ctx()), false);
    assert.equal(applyChatFrame(cell, approval("run_1"), ctx()), false);
    assert.equal(cell.current, null);
  });

  test("a child frame addressed to a finished turn leaves the live turn intact", () => {
    // The scenario that previously needed a browser and synthetic
    // `events_outbox` rows: a spawn outlives its parent turn, so a late child
    // frame can land while a completely different turn is streaming. Mounting
    // for it would blank turn 2's bubble and reset its delta seq.
    const cell = cellOf();
    applyChatFrame(cell, started(TURN), ctx());
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "child_tool_1" }), ctx());
    assert.equal(refOf(cell).subAgents.size, 1);

    applyChatFrame(cell, started(TURN_2), ctx());
    assert.equal(applyChatFrame(cell, delta(1, "Hello", { turn: TURN_2 }), ctx()), true);

    const stale = tool({ subAgent: SUB, toolCallId: "child_tool_2", turn: TURN });
    assert.equal(applyChatFrame(cell, stale, ctx()), false);

    assert.equal(refOf(cell).messageId, "msg_2");
    assert.equal(refOf(cell).subAgents.size, 0);
    // The proof that `deltaSeq` was not reset: seq 2 still appends. If the stale
    // frame had mounted a fresh ref, deltaSeq would be 0 and this would pass for
    // the wrong reason — so assert the accumulated text, not just the return.
    assert.equal(applyChatFrame(cell, delta(2, " world", { turn: TURN_2 }), ctx()), true);
    assert.equal(drain(cell).snapshot.text, "Hello world");
  });

  test("a replayed `started` for the same turn does not clear what has arrived", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, delta(3, "partial answer"), ctx());
    applyChatFrame(cell, tool({ status: "succeeded" }), ctx());

    assert.equal(applyChatFrame(cell, started(), ctx()), true);
    assert.equal(refOf(cell).deltaSeq, 3);
    assert.equal(refOf(cell).segments.get(0), "partial answer");
    assert.equal(refOf(cell).tools.size, 1);
  });

  test("a different runId for the same messageId mounts a fresh turn (a retry)", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, delta(3, "first attempt"), ctx());

    const retry = { threadId: THREAD, messageId: "msg_1", runId: "run_2" };
    assert.equal(applyChatFrame(cell, started(retry), ctx()), true);
    assert.equal(refOf(cell).deltaSeq, 0);
    assert.equal(refOf(cell).segments.size, 0);
  });

  test("a delta can mount the turn when `started` was missed", () => {
    // The `/chat` -> `/chat/<id>` navigation reopens the SSE stream and the bus
    // has no replay, so `started` can fire in the gap. Any frame carrying its
    // own (messageId, runId) may mount; the two kinds that carry no threadId
    // may not.
    const cell = cellOf();
    assert.equal(applyChatFrame(cell, delta(1, "hi"), ctx()), true);
    assert.equal(refOf(cell).messageId, "msg_1");
  });
});

describe("applyChatFrame — absorption (a terminal is absorbing)", () => {
  const withTrail = () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "child_tool_1" }), ctx(1_000));
    return cell;
  };
  const trailOf = (cell: ChatStreamCell) => {
    const trail = refOf(cell).subAgents.get(SUB.parentToolCallId);
    assert.ok(trail, "expected a sub-agent trail");
    return trail;
  };

  test("a terminal trail outcome is never reopened", () => {
    const cell = withTrail();
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "completed"), ctx(2_000)), true);
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "failed"), ctx(9_000)), false);
    assert.deepEqual(
      { outcome: trailOf(cell).outcome, endedTs: trailOf(cell).endedTs },
      { outcome: "completed", endedTs: 2_000 },
    );
  });

  test("`interrupted` parks the trail and activity un-parks it", () => {
    const cell = withTrail();
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "interrupted"), ctx(2_000)), true);
    assert.deepEqual(
      { waiting: trailOf(cell).waiting, outcome: trailOf(cell).outcome },
      { waiting: true, outcome: null },
    );

    // Nothing publishes `resumed`; a resuming run emits `step_started`.
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "step_started"), ctx(3_000)), true);
    assert.equal(trailOf(cell).waiting, false);

    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "cancelled"), ctx(4_000)), true);
    assert.deepEqual(
      { waiting: trailOf(cell).waiting, outcome: trailOf(cell).outcome },
      { waiting: false, outcome: "cancelled" },
    );
  });

  test("an agent.run for an unmapped runId touches nothing", () => {
    const cell = withTrail();
    assert.equal(applyChatFrame(cell, run("run_unrelated", "completed"), ctx()), false);
    assert.equal(trailOf(cell).outcome, null);
  });

  test("a local stop freezes the reply and every later frame is dropped", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, reasoning(1, "thinking hard about it"), ctx(1_000));
    applyChatFrame(cell, delta(1, "0123456789012345678901234567890123456789"), ctx(1_100));

    // One tick, so `shown` is a strict prefix — the freeze has to be visible.
    const ref = refOf(cell);
    const { snapshot: mid } = tickDrip(ref);
    assert.ok(mid.text.length > 0 && mid.text.length < 40, `unexpected prefix: ${mid.text}`);

    assert.equal(applyOptimisticStop(cell), true);
    const frozen = drain(cell).snapshot;
    assert.equal(frozen.text, mid.text);
    assert.equal(frozen.reasoning, mid.reasoning);
    assert.equal(frozen.done, true);

    assert.equal(applyChatFrame(cell, delta(2, " and more"), ctx()), false);
    assert.equal(applyChatFrame(cell, reasoning(2, " and more"), ctx()), false);
    assert.equal(applyChatFrame(cell, tool({ toolCallId: "tool_late" }), ctx()), false);
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "completed"), ctx()), false);
    assert.equal(applyChatFrame(cell, approval("run_1"), ctx()), false);

    const after = drain(cell).snapshot;
    assert.equal(after.text, mid.text);
    assert.equal(after.tools.length, 0);
    assert.equal(after.done, true);
  });

  test("a stop freezes only its own run — the next turn still mounts", () => {
    // `stopped` is checked on the ref the frame *names*, which is why the mount
    // happens first. Check it against whatever is currently in the cell instead
    // and the turn after a stop never renders at all.
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, delta(1, "half an answer"), ctx());
    applyOptimisticStop(cell);

    assert.equal(applyChatFrame(cell, delta(1, "a fresh turn", { turn: TURN_2 }), ctx()), true);
    assert.equal(refOf(cell).messageId, "msg_2");
    assert.equal(refOf(cell).stopped, false);
    assert.equal(drain(cell).snapshot.text, "a fresh turn");
  });

  test("a second stop, and a stop with nothing in flight, are no-ops", () => {
    assert.equal(applyOptimisticStop(cellOf()), false);
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    assert.equal(applyOptimisticStop(cell), true);
    assert.equal(applyOptimisticStop(cell), false);
  });
});

describe("applyChatFrame — monotonicity (clause 3)", () => {
  test("a stale delta seq is dropped without touching the text", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    assert.equal(applyChatFrame(cell, delta(3, "third"), ctx()), true);
    assert.equal(applyChatFrame(cell, delta(2, "second"), ctx()), false);
    assert.equal(refOf(cell).deltaSeq, 3);
    assert.equal(drain(cell).snapshot.text, "third");
  });

  test("a stale reasoning seq is dropped without touching the thinking", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    assert.equal(applyChatFrame(cell, reasoning(3, "third"), ctx()), true);
    assert.equal(applyChatFrame(cell, reasoning(2, "second"), ctx()), false);
    assert.equal(refOf(cell).reasoningSeq, 3);
    assert.equal(drain(cell).snapshot.reasoning, "third");
  });
});

describe("applyChatFrame — thread filter", () => {
  const other: Turn = { threadId: "thread_other", messageId: "msg_x", runId: "run_x" };

  test("every threadId-carrying kind ignores another thread's frame", () => {
    for (const frame of [
      started(other),
      delta(1, "not ours", { turn: other }),
      reasoning(1, "not ours", other),
      tool({ turn: other }),
    ]) {
      const cell = cellOf();
      assert.equal(
        applyChatFrame(cell, frame, ctx()),
        false,
        `${frame.kind} leaked across threads`,
      );
      assert.equal(cell.current, null);
    }
  });
});

describe("applyChatFrame — reasoningMs", () => {
  test("freezes at the first delta and does not move again", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, reasoning(1, "thinking"), ctx(1_000));
    applyChatFrame(cell, delta(1, "answer"), ctx(1_250));
    assert.equal(refOf(cell).reasoningMs, 250);

    applyChatFrame(cell, reasoning(2, " more"), ctx(5_000));
    applyChatFrame(cell, delta(2, " more"), ctx(6_000));
    assert.equal(refOf(cell).reasoningMs, 250);
  });

  test("stays null when no reasoning ever arrived", () => {
    const cell = cellOf();
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, delta(1, "answer"), ctx(1_250));
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
    applyChatFrame(cell, started(), ctx());
    return cell;
  };

  test("chat.message", () => {
    const cell = mounted();
    assert.equal(applyChatFrame(cell, compaction("compaction_started"), ctx()), true);
    assert.equal(refOf(cell).compacting, true);
    assert.equal(applyChatFrame(cell, compaction("compaction_finished"), ctx()), true);
    assert.equal(refOf(cell).compacting, false);
    // A compaction or completion phase naming a turn we do not hold changes
    // nothing, so it must not schedule a frame.
    assert.equal(applyChatFrame(cell, compaction("compaction_started", TURN_2), ctx()), false);
    assert.equal(applyChatFrame(cell, completed(TURN_2), ctx()), false);
    assert.equal(applyChatFrame(cell, completed(), ctx()), true);
    assert.equal(refOf(cell).done, true);
  });

  test("chat.tool — sub-agent arm", () => {
    const cell = mounted();
    // A bounce with no trail to retract draws nothing, so it must not tick.
    assert.equal(
      applyChatFrame(cell, tool({ subAgent: SUB, nonExecution: true }), ctx()),
      false,
      "an empty sub-agent container is worse than silence",
    );
    assert.equal(refOf(cell).subAgents.size, 0);

    assert.equal(applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "ct_1" }), ctx()), true);
    // With a trail present, a bounce does retract and must re-project.
    assert.equal(
      applyChatFrame(
        cell,
        tool({ subAgent: SUB, toolCallId: "ct_1", status: "failed", nonExecution: true }),
        ctx(),
      ),
      true,
    );
  });

  test("chat.tool — the boss's own calls", () => {
    const cell = mounted();
    assert.equal(applyChatFrame(cell, tool({ toolCallId: "t_1" }), ctx()), true);
    assert.equal(
      applyChatFrame(cell, tool({ toolCallId: "t_1", status: "succeeded" }), ctx()),
      true,
    );
    // A retraction mutates the trail even though it records no timing mark.
    assert.equal(
      applyChatFrame(
        cell,
        tool({ toolCallId: "t_1", status: "failed", nonExecution: true }),
        ctx(),
      ),
      true,
    );
    assert.equal(refOf(cell).tools.size, 0);
  });

  test("agent.run — a non-terminal phase for a trail that was never parked", () => {
    const cell = mounted();
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "ct_1" }), ctx());
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "step_started"), ctx()), false);
    assert.equal(applyChatFrame(cell, run(SUB.childRunId, "step_completed"), ctx()), false);
  });

  test("approval.requested", () => {
    const cell = mounted();
    assert.equal(applyChatFrame(cell, approval("run_other"), ctx()), false);
    assert.equal(refOf(cell).awaitingApproval, false);
    assert.equal(applyChatFrame(cell, approval("run_1"), ctx()), true);
    assert.equal(refOf(cell).awaitingApproval, true);
    // `completed` clears the wait, so it still has to re-project.
    assert.equal(applyChatFrame(cell, completed(), ctx()), true);
    assert.equal(refOf(cell).awaitingApproval, false);
  });

  test("a kind the chat turn does not read", () => {
    const cell = mounted();
    assert.equal(applyChatFrame(cell, unrelated(), ctx()), false);
  });
});

describe("tickDrip", () => {
  test("terminates, and never shows more than has been received", () => {
    const cell = cellOf();
    const answer = "The quick brown fox jumps over the lazy dog, twice, for luck.";
    const thinking = "Checking the calendar first.";
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, reasoning(1, thinking), ctx());
    applyChatFrame(cell, delta(1, answer), ctx());

    const ref = refOf(cell);
    let previous = 0;
    let ticks = 0;
    for (;;) {
      ticks += 1;
      assert.ok(ticks <= 500, "tickDrip did not converge");
      const { snapshot, caughtUp } = tickDrip(ref);
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
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, delta(1, "Looking that up.", { segmentIndex: 0 }), ctx());
    applyChatFrame(cell, delta(2, "   ", { segmentIndex: 1 }), ctx());
    applyChatFrame(cell, delta(3, "Here it is.", { segmentIndex: 2 }), ctx());

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
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(
      cell,
      delta(1, "A long first narration segment here, comfortably longer.", {
        segmentIndex: 0,
      }),
      ctx(),
    );
    drain(cell);
    applyChatFrame(cell, delta(2, second, { segmentIndex: 1 }), ctx());

    const { snapshot } = tickDrip(refOf(cell));
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
    applyChatFrame(cell, started(), ctx());
    applyChatFrame(cell, delta(1, "done"), ctx());
    applyChatFrame(cell, tool({ subAgent: SUB, toolCallId: "ct_1" }), ctx());
    return cell;
  };

  test("a settled projection compares equal to itself", () => {
    const cell = streamingTurn();
    const first = drain(cell).snapshot;
    const { snapshot: second } = tickDrip(refOf(cell));
    assert.equal(streamSnapshotsEqual(first, second), true);
  });

  test("a trail's `waiting` flip alone is not equal", () => {
    const cell = streamingTurn();
    const before = drain(cell).snapshot;
    applyChatFrame(cell, run(SUB.childRunId, "interrupted"), ctx(2_000));
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
