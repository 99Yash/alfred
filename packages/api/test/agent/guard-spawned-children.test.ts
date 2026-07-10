import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ChildRunOutcome } from "../../src/modules/agent/sub-agents";
import { AWAIT_SUB_AGENT_CEILING_MS } from "../../src/modules/agent/sub-agent-join-wake-queue";
import {
  awaitedChildRunId,
  guardSpawnedChildren,
  markProductiveChatTurn,
  type ChatRunState,
  type GuardSpawnedChildrenDeps,
} from "../../src/modules/agent/workflows/chat-turn";
import type { StepContext } from "../../src/modules/agent/types";

/**
 * Unit tests for the ADR-0073 finalization guard (#268). This guard is the
 * runtime invariant — "the parent turn cannot complete while a child it spawned
 * is still running" — so it carries direct regression coverage for the failure
 * modes that would otherwise strand a parent or leak a rejected answer:
 *
 *  - a dead-man timer that can't be scheduled → fold + finalize, never park
 *    (else `findResumableRunIds` never sweeps `waiting` and the run hangs);
 *  - a child past the wait-ceiling → fold + finalize, never re-park (else each
 *    wake re-arms the same six-minute timer and parks forever);
 *  - a terminal child → fold its outcome and regenerate an informed answer;
 *  - the live segment transition → a zero-length delta on the next segment so
 *    the client stops rendering the premature answer the guard rejected.
 *
 * No DB or Redis: the guard's I/O is injected.
 */

const RUN_ID = "run_parent";
const USER_ID = "user_1";

function baseState(overrides: Partial<ChatRunState> = {}): ChatRunState {
  return {
    threadId: "thread_1",
    messageId: "msg_1",
    tier: "standard",
    activeIntegrations: [],
    allowedIntegrations: [],
    pendingToolCalls: [],
    assistantText: "premature answer",
    narration: [],
    segmentIndex: 0,
    reasoningText: "",
    reasoningMs: 0,
    toolCallsLog: [
      {
        toolCallId: "tc_1",
        toolName: "system.spawn_sub_agent",
        status: "succeeded",
        segmentIndex: 0,
      },
    ],
    deltaSeq: 7,
    reasoningSeq: 0,
    turnCount: 1,
    emptyCompletionRetries: 0,
    started: true,
    foldedChildRunIds: [],
    notedFailureToolCallIds: [],
    ...overrides,
  };
}

function baseCtx(state: ChatRunState): StepContext<ChatRunState> {
  return {
    runId: RUN_ID,
    userId: USER_ID,
    idempotencyKey: "key_1",
    attempt: 1,
    state,
    transcript: [],
    stageAction: () => {},
    log: async () => {},
    trace: () => {},
  };
}

interface Recorder {
  deps: GuardSpawnedChildrenDeps;
  scheduleCalls: string[];
  published: Array<{ kind: string; payload: Record<string, unknown> }>;
}

function recorder(args: {
  children: Array<{ id: string; status: string }>;
  outcomes: Record<string, ChildRunOutcome>;
  scheduleResult?: "scheduled" | "disabled" | "failed";
}): Recorder {
  const scheduleCalls: string[] = [];
  const published: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const deps: GuardSpawnedChildrenDeps = {
    listChildren: async () => args.children,
    readOutcome: async ({ childRunId }) => {
      const outcome = args.outcomes[childRunId];
      if (!outcome) throw new Error(`no fake outcome for ${childRunId}`);
      return outcome;
    },
    scheduleWake: async ({ childRunId }) => {
      scheduleCalls.push(childRunId);
      return args.scheduleResult ?? "scheduled";
    },
    publish: async (event) => {
      published.push({ kind: event.kind, payload: event.payload as Record<string, unknown> });
    },
  };
  return { deps, scheduleCalls, published };
}

describe("guardSpawnedChildren (ADR-0073 runtime invariant)", () => {
  test("no spawn this turn → returns null (turn finalizes normally)", async () => {
    const state = baseState({ toolCallsLog: [] });
    const rec = recorder({ children: [], outcomes: {} });
    const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
    assert.equal(result, null);
  });

  test("a running child within the ceiling parks on its done-signal", async () => {
    const state = baseState();
    const rec = recorder({
      children: [{ id: "child_a", status: "running" }],
      outcomes: { child_a: { ok: true, done: false, status: "running", runningMs: 1_000 } },
      scheduleResult: "scheduled",
    });
    const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
    assert.equal(result?.kind, "interrupt");
    assert.deepEqual(rec.scheduleCalls, ["child_a"], "the dead-man timer was scheduled");
    assert.equal(
      result?.kind === "interrupt" ? result.wake.kind : undefined,
      "signal",
      "parks on the child's completion signal",
    );
    // It must NOT have been folded — there's no result yet to surface.
    assert.deepEqual(state.foldedChildRunIds, []);
  });

  test("scheduling failure → folds and finalizes instead of parking (never strand in waiting)", async () => {
    for (const scheduleResult of ["disabled", "failed"] as const) {
      const state = baseState();
      const rec = recorder({
        children: [{ id: "child_a", status: "running" }],
        outcomes: { child_a: { ok: true, done: false, status: "running", runningMs: 1_000 } },
        scheduleResult,
      });
      const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
      assert.equal(
        result?.kind,
        "next",
        `scheduleWake=${scheduleResult} must not park — it loops back to regenerate`,
      );
      assert.deepEqual(state.foldedChildRunIds, ["child_a"], "the child is folded, not re-tracked");
      const folded = result?.kind === "next" ? result.transcript : undefined;
      assert.match(
        String(folded?.[0]?.content ?? ""),
        /could not be awaited \(join_timer_unavailable\)/,
        "the fold tells the boss the timer was unavailable",
      );
    }
  });

  test("a child past the wait-ceiling → folds, never re-parks (no infinite re-park)", async () => {
    const state = baseState();
    const rec = recorder({
      children: [{ id: "child_a", status: "running" }],
      outcomes: {
        child_a: {
          ok: true,
          done: false,
          status: "running",
          runningMs: AWAIT_SUB_AGENT_CEILING_MS + 60_000,
        },
      },
    });
    const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
    assert.equal(result?.kind, "next", "a stuck child past the ceiling does not park again");
    assert.deepEqual(rec.scheduleCalls, [], "no fresh timer is armed for a past-ceiling child");
    assert.deepEqual(state.foldedChildRunIds, ["child_a"]);
    const folded = result?.kind === "next" ? result.transcript : undefined;
    assert.match(String(folded?.[0]?.content ?? ""), /could not be awaited/);
  });

  test("a terminal child is folded and regenerates an informed answer", async () => {
    const state = baseState();
    const rec = recorder({
      children: [{ id: "child_a", status: "completed" }],
      outcomes: {
        child_a: {
          ok: true,
          done: true,
          status: "completed",
          output: { summary: "did the thing" },
        },
      },
    });
    const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
    assert.equal(result?.kind, "next");
    assert.deepEqual(rec.scheduleCalls, [], "a terminal child is never parked on");
    assert.deepEqual(state.foldedChildRunIds, ["child_a"]);
    const folded = result?.kind === "next" ? result.transcript : undefined;
    assert.match(
      String(folded?.[0]?.content ?? ""),
      /finished without you awaiting it — it completed/,
      "the fold carries the terminal result for the regenerated answer",
    );
  });

  test("a productive answer resets prior empty retries before guarded regeneration", async () => {
    const state = baseState({ emptyCompletionRetries: 2 });
    const rec = recorder({
      children: [{ id: "child_a", status: "completed" }],
      outcomes: {
        child_a: {
          ok: true,
          done: true,
          status: "completed",
          output: { summary: "did the thing" },
        },
      },
    });

    // Mirrors the productive-text boundary immediately before the guard in the
    // chat workflow. If the guard regenerates, its returned state must carry a
    // fresh retry budget rather than the streak from before this real answer.
    markProductiveChatTurn(state);
    const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);

    assert.equal(result?.kind, "next");
    assert.equal(result?.state.emptyCompletionRetries, 0);
  });

  test("one terminal + one running child: folds the terminal, parks on the running one", async () => {
    const state = baseState();
    const rec = recorder({
      children: [
        { id: "child_done", status: "completed" },
        { id: "child_run", status: "running" },
      ],
      outcomes: {
        child_done: { ok: true, done: true, status: "completed", output: { ok: 1 } },
        child_run: { ok: true, done: false, status: "running", runningMs: 500 },
      },
      scheduleResult: "scheduled",
    });
    const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
    assert.equal(result?.kind, "interrupt");
    assert.deepEqual(state.foldedChildRunIds, ["child_done"], "only the terminal child is folded");
    assert.deepEqual(rec.scheduleCalls, ["child_run"], "the timer is armed for the running child");
  });

  test("an already-folded child is skipped (idempotent across resumes)", async () => {
    const state = baseState({ foldedChildRunIds: ["child_a"] });
    const rec = recorder({
      children: [{ id: "child_a", status: "completed" }],
      outcomes: { child_a: { ok: true, done: true, status: "completed", output: {} } },
    });
    const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
    assert.equal(result, null, "nothing left unfolded → the turn finalizes normally");
    assert.equal(rec.published.length, 0, "no segment churn when there's nothing to guard");
  });

  test("spawn + terminal await → guard returns null (no false 'unawaited' note)", async () => {
    // The boss spawned a child and then correctly `await_sub_agent`'d it. The
    // dispatch commit pass records that successful await by adding the child to
    // `foldedChildRunIds` (see `awaitedChildRunId` accounting), so the guard must
    // see nothing left to fold — otherwise it injects the false "finished without
    // you awaiting it" note, demotes the streamed answer, and burns a turn.
    const state = baseState({
      toolCallsLog: [
        {
          toolCallId: "tc_spawn",
          toolName: "system.spawn_sub_agent",
          status: "succeeded",
          segmentIndex: 0,
        },
        {
          toolCallId: "tc_await",
          toolName: "system.await_sub_agent",
          status: "succeeded",
          segmentIndex: 0,
        },
      ],
      // What the commit-pass accounting leaves behind for an awaited child.
      foldedChildRunIds: ["child_a"],
    });
    const rec = recorder({
      children: [{ id: "child_a", status: "completed" }],
      outcomes: { child_a: { ok: true, done: true, status: "completed", output: { ok: 1 } } },
    });
    const result = await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
    assert.equal(result, null, "the awaited child is already accounted for → finalize normally");
    assert.equal(rec.published.length, 0, "no segment churn for a correctly-awaited child");
  });

  test("awaitedChildRunId extracts the childRunId from a well-formed await input", () => {
    assert.equal(awaitedChildRunId({ childRunId: "run_child" }), "run_child");
    assert.equal(awaitedChildRunId({ childRunId: "" }), null);
    assert.equal(awaitedChildRunId({ childRunId: 42 }), null);
    assert.equal(awaitedChildRunId({}), null);
    assert.equal(awaitedChildRunId(null), null);
    assert.equal(awaitedChildRunId("run_child"), null);
  });

  test("the live segment transition: a zero-length delta closes the premature answer", async () => {
    const state = baseState({ assistantText: "premature answer", segmentIndex: 2, deltaSeq: 9 });
    const rec = recorder({
      children: [{ id: "child_a", status: "running" }],
      outcomes: { child_a: { ok: true, done: false, status: "running", runningMs: 1_000 } },
      scheduleResult: "scheduled",
    });
    await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);

    // Server state: the premature text is demoted to narration and the segment advances.
    assert.equal(state.assistantText, "", "the premature answer is cleared from the live segment");
    assert.deepEqual(
      state.narration,
      [{ index: 2, text: "premature answer" }],
      "the premature answer is parked into the narration trail",
    );
    assert.equal(state.segmentIndex, 3, "the segment advanced past the rejected answer");

    // Client frame: a higher-seq, zero-length delta on the NEW segment so
    // use-chat-stream advances `currentSegment` and stops rendering the premature
    // text as the live reply.
    const deltas = rec.published.filter((p) => p.kind === "chat.delta");
    assert.equal(deltas.length, 1, "exactly one segment-advance frame is emitted");
    assert.equal(deltas[0]?.payload.text, "");
    assert.equal(deltas[0]?.payload.segmentIndex, 3, "the frame opens the new segment");
    assert.equal(deltas[0]?.payload.seq, 10, "the frame carries a higher delta seq");
  });

  test("no premature text → no segment churn and no client frame", async () => {
    const state = baseState({ assistantText: "", segmentIndex: 1, deltaSeq: 4 });
    const rec = recorder({
      children: [{ id: "child_a", status: "running" }],
      outcomes: { child_a: { ok: true, done: false, status: "running", runningMs: 1_000 } },
      scheduleResult: "scheduled",
    });
    await guardSpawnedChildren(baseCtx(state), state, [], rec.deps);
    assert.equal(state.segmentIndex, 1, "no answer to close → segment index is untouched");
    assert.equal(state.deltaSeq, 4, "no delta seq is consumed");
    assert.equal(rec.published.filter((p) => p.kind === "chat.delta").length, 0);
  });
});
