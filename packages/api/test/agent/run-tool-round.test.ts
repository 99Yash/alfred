import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isRecord } from "@alfred/contracts";
import type { DispatchResult } from "../../src/modules/dispatch";
import type { DispatchBatchSpanCloser } from "../../src/modules/agent/runtime-spans";
import { runToolRound } from "../../src/modules/agent/workflows/tool-round";

/**
 * `runToolRound` is the shared "how a tool round runs" — the span-close rule,
 * the staged-before-parked interrupt priority, and the ordered commit pass —
 * that the chat turn and the sub-agent brief both consume so the two can never
 * drift. These exercise it without a live run.
 */

type Call = { toolCallId: string; toolName: string; input: unknown };

function call(toolCallId: string, toolName: string): Call {
  return { toolCallId, toolName, input: {} };
}

const executed = (toolResult: unknown): DispatchResult => ({
  kind: "executed",
  stagingId: null,
  toolResult,
  editedByUser: false,
});

const staged = (id: string): DispatchResult => ({
  kind: "staged",
  stagingId: id,
  wake: { kind: "hil", approvalId: id, approvalKind: "action_staging", prompt: `Approve ${id}` },
});

const parked = (name: string): DispatchResult => ({
  kind: "parked",
  wake: { kind: "signal", name },
});

/** A span recorder implementing the real closer contract so we can assert which
 *  terminal was folded (and that the fold happens exactly once). */
function recordingSpan(): {
  span: DispatchBatchSpanCloser;
  terminals: string[];
} {
  const terminals: string[] = [];
  const span: DispatchBatchSpanCloser = {
    end(terminal: "committed" | "staged" | "parked" | "error") {
      terminals.push(terminal);
    },
  };
  return { span, terminals };
}

describe("runToolRound — serial ordering (the brief's strategy)", () => {
  test("commits every result in model order and closes the span committed", async () => {
    const calls = [call("a", "gmail.search"), call("b", "system.web_search")];
    const results: Record<string, DispatchResult> = {
      a: executed({ ok: 1 }),
      b: executed({ ok: 2 }),
    };
    const committed: string[] = [];
    const { span, terminals } = recordingSpan();

    const outcome = await runToolRound<Call>({
      calls,
      transcript: [],
      batchSpan: span,
      ordering: { kind: "serial" },
      dispatch: (c) => Promise.resolve(results[c.toolCallId]!),
      onCommit: (c) => {
        committed.push(c.toolCallId);
      },
    });

    assert.equal(outcome.kind, "committed");
    assert.deepEqual(committed, ["a", "b"], "onCommit runs in model order");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0], "committed");
    if (outcome.kind !== "committed") return;
    // One tool-result message appended per call, keyed by its toolCallId.
    assert.equal(outcome.transcript.length, 2);
    const firstOutput = outcome.transcript[0]?.content[0];
    assert.ok(isRecord(firstOutput) && firstOutput.toolCallId === "a");
  });

  test("a staged write ends the round: batch untouched, nothing committed", async () => {
    const calls = [call("a", "gmail.search"), call("b", "gmail.send"), call("c", "gmail.archive")];
    const dispatched: string[] = [];
    const results: Record<string, DispatchResult> = {
      a: executed({ ok: 1 }),
      b: staged("stage-b"),
      c: executed({ ok: 3 }),
    };
    const committed: string[] = [];
    const { span, terminals } = recordingSpan();

    const outcome = await runToolRound<Call>({
      calls,
      transcript: [],
      batchSpan: span,
      ordering: { kind: "serial" },
      dispatch: (c) => {
        dispatched.push(c.toolCallId);
        return Promise.resolve(results[c.toolCallId]!);
      },
      onCommit: (c) => {
        committed.push(c.toolCallId);
      },
    });

    assert.equal(outcome.kind, "interrupt");
    if (outcome.kind !== "interrupt") return;
    assert.equal(outcome.wake.kind, "hil");
    // Stops at the first stage — `c` is never dispatched (re-runs on resume).
    assert.deepEqual(dispatched, ["a", "b"]);
    // Nothing commits on an interrupt: the whole batch re-dispatches on resume.
    assert.deepEqual(committed, []);
    assert.deepEqual(terminals, ["staged"]);
  });
});

describe("runToolRound — interrupt priority", () => {
  test("a staged write is surfaced before a sub-agent park", async () => {
    // Concurrent-autonomy: the park rides the autonomy lane, the stage the gated
    // one. Both are present in the batch; the HIL stage must win.
    const calls = [call("a", "system.await_sub_agent"), call("b", "gmail.send")];
    const results: Record<string, DispatchResult> = {
      a: parked("child-done"),
      b: staged("stage-b"),
    };
    const { span, terminals } = recordingSpan();

    const outcome = await runToolRound<Call>({
      calls,
      transcript: [],
      batchSpan: span,
      ordering: {
        kind: "concurrent-autonomy",
        gateFlags: [false, true],
        serializeInOrder: () => false,
      },
      dispatch: (c) => Promise.resolve(results[c.toolCallId]!),
    });

    assert.equal(outcome.kind, "interrupt");
    if (outcome.kind !== "interrupt") return;
    assert.equal(outcome.wake.kind, "hil", "HIL staging takes precedence over a park");
    assert.deepEqual(terminals, ["staged"]);
  });

  test("a lone park surfaces its signal wake", async () => {
    const calls = [call("a", "system.await_sub_agent")];
    const { span, terminals } = recordingSpan();

    const outcome = await runToolRound<Call>({
      calls,
      transcript: [],
      batchSpan: span,
      ordering: { kind: "serial" },
      dispatch: () => Promise.resolve(parked("child-done")),
    });

    assert.equal(outcome.kind, "interrupt");
    if (outcome.kind !== "interrupt") return;
    assert.equal(outcome.wake.kind, "signal");
    assert.deepEqual(terminals, ["parked"]);
  });
});

describe("runToolRound — faults", () => {
  test("a thrown dispatch closes the span errored and rethrows", async () => {
    const { span, terminals } = recordingSpan();
    await assert.rejects(
      runToolRound<Call>({
        calls: [call("a", "gmail.search")],
        transcript: [],
        batchSpan: span,
        ordering: { kind: "serial" },
        dispatch: () => Promise.reject(new Error("boom")),
      }),
      /boom/,
    );
    assert.deepEqual(terminals, ["error"]);
  });
});
