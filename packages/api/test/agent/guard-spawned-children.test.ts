import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentTranscriptMessage } from "@alfred/contracts";
import type { ChildRunOutcome } from "../../src/modules/agent/sub-agents";
import { AWAIT_SUB_AGENT_CEILING_MS } from "../../src/modules/agent/sub-agent-join-wake-queue";
import {
  awaitedChildRunId,
  guardSpawnedChildren,
  planEmptyChatCompletionRetry,
  planStreamTimeoutRetry,
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
    activeTools: [],
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
    streamTimeoutRetries: 0,
    startedAt: "2026-07-14T02:50:11.451Z",
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

  test("an empty completion retries from the exact pre-turn transcript", () => {
    const state = baseState({ emptyCompletionRetries: 1 });
    const transcript = [{ role: "user" as const, content: "Keep this request" }];
    const result = planEmptyChatCompletionRetry(state, transcript);

    assert.equal(result?.kind, "next");
    assert.equal(result?.state.emptyCompletionRetries, 2);
    assert.equal(state.emptyCompletionRetries, 1, "planning does not mutate checkpoint state");
    assert.strictEqual(
      result?.kind === "next" ? result.transcript : undefined,
      transcript,
      "the empty assistant response is never appended to the retry transcript",
    );
  });

  test("the empty-completion retry budget is bounded", () => {
    const state = baseState({ emptyCompletionRetries: 2 });
    assert.equal(planEmptyChatCompletionRetry(state, []), null);
  });

  test("a stream-timeout retries from the exact pre-turn transcript", () => {
    const state = baseState({ streamTimeoutRetries: 0 });
    const transcript = [{ role: "user" as const, content: "Build the resume" }];
    const result = planStreamTimeoutRetry(state, transcript);

    assert.equal(result?.kind, "next");
    assert.equal(result?.state.streamTimeoutRetries, 1);
    assert.equal(state.streamTimeoutRetries, 0, "planning does not mutate checkpoint state");
    assert.strictEqual(
      result?.kind === "next" ? result.transcript : undefined,
      transcript,
      "the retry re-issues the model call from the unchanged pre-turn transcript",
    );
  });

  test("the stream-timeout retry budget is bounded to one", () => {
    const state = baseState({ streamTimeoutRetries: 1 });
    assert.equal(planStreamTimeoutRetry(state, []), null);
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

  // A turn that spawns a child, skips the prompted `await_sub_agent`, and then
  // streams a final answer arrives here with the transcript tail
  // `…, tool, assistant[reasoning,text]` — the last assistant message is the
  // premature answer `appendModelResponseMessages` appended. The guard closes
  // that answer into narration, so it must also drop it from the transcript it
  // forwards: on the PARK path the parked transcript becomes `ctx.transcript`
  // and the resumed step re-invokes the model with it BEFORE the guard runs
  // again — a transcript ending in an assistant message is an illegal prefill
  // under extended thinking (Anthropic 400 "the conversation must end with a
  // user message", which previously retried 9× and failed the turn).
  const prematureTail = (): AgentTranscriptMessage[] => [
    { role: "user", content: "summarize my open PRs" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "tc_spawn", toolName: "system.spawn_sub_agent" }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "tc_spawn", output: { childRunId: "child_a" } }],
    },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "…" },
        { type: "text", text: "premature answer" },
      ],
    },
  ];

  test("parking strips the premature assistant tail (no illegal-prefill 400 on resume)", async () => {
    const state = baseState({
      assistantText: "premature answer",
      runtimeGroundingAnchor: "2026-07-15T03:58:00.000Z",
    });
    const rec = recorder({
      children: [{ id: "child_a", status: "running" }],
      outcomes: { child_a: { ok: true, done: false, status: "running", runningMs: 1_000 } },
      scheduleResult: "scheduled",
    });
    const result = await guardSpawnedChildren(baseCtx(state), state, prematureTail(), rec.deps);
    assert.equal(result?.kind, "interrupt", "a still-running child parks");
    assert.equal(
      state.runtimeGroundingAnchor,
      undefined,
      "the park lifecycle seam invalidates grounding even for a short wake gap",
    );
    const forwarded = result?.kind === "interrupt" ? (result.transcript ?? []) : [];
    assert.notEqual(
      forwarded.at(-1)?.role,
      "assistant",
      "the parked transcript must NOT end in an assistant message (prefill 400)",
    );
    assert.equal(
      forwarded.at(-1)?.role,
      "tool",
      "it ends at the tool results — a legal turn-ender the resumed model call accepts",
    );
    assert.equal(forwarded.length, 3, "exactly the premature assistant tail was dropped");
  });

  test("folding a terminal child drops the premature assistant tail and ends in the user fold", async () => {
    const state = baseState({ assistantText: "premature answer" });
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
    const result = await guardSpawnedChildren(baseCtx(state), state, prematureTail(), rec.deps);
    assert.equal(result?.kind, "next");
    const forwarded = result?.kind === "next" ? (result.transcript ?? []) : [];
    assert.equal(
      forwarded.at(-1)?.role,
      "user",
      "the regenerate transcript ends in the synthetic fold",
    );
    assert.match(
      String(forwarded.at(-1)?.content ?? ""),
      /finished without you awaiting it — it completed/,
    );
    assert.ok(
      !forwarded.some(
        (m) =>
          m.role === "assistant" && JSON.stringify(m.content).includes('"text":"premature answer"'),
      ),
      "the uninformed premature answer is not carried into the regenerate transcript (narration keeps it for the UI)",
    );
  });

  test("mixed terminal + running with a premature tail: parks on a transcript ending in the fold, not the assistant", async () => {
    const state = baseState({ assistantText: "premature answer" });
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
    const result = await guardSpawnedChildren(baseCtx(state), state, prematureTail(), rec.deps);
    assert.equal(result?.kind, "interrupt");
    const forwarded = result?.kind === "interrupt" ? (result.transcript ?? []) : [];
    assert.equal(
      forwarded.at(-1)?.role,
      "user",
      "the terminal fold is the legal turn-ender, not the assistant tail",
    );
    assert.deepEqual(state.foldedChildRunIds, ["child_done"]);
    assert.deepEqual(rec.scheduleCalls, ["child_run"]);
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
