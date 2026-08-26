import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import {
  chatRunStateSchema,
  foldResumedPark,
  interruptChatRun,
  type ChatRunState,
} from "@alfred/assistant/chat/chat-turn-state";
import {
  buildTurnPhaseSpanInput,
  dispatchSharePct,
  emitTurnPhaseThermometer,
  otherPhaseMs,
  RUNTIME_TURN_PHASES,
  _setTurnThermometerStarterForTests,
} from "@alfred/assistant/chat/turn-thermometer";
import { resetToolFixtures } from "@alfred/assistant/tool-runtime/test-support";

/** Build a full run state from the schema so the transform's defaults apply. */
function state(overrides: Record<string, unknown> = {}): ChatRunState {
  // The schema transform restores the tool surface, which reads the
  // tool-runtime adapter; register the fixture adapter so the parse resolves.
  resetToolFixtures();
  return chatRunStateSchema.parse({
    threadId: "thr_1",
    messageId: "msg_1",
    tier: "standard",
    allowedIntegrations: [],
    pendingToolCalls: [],
    activeTools: [],
    ...overrides,
  });
}

interface CapturedSpans {
  opened: RuntimeSpanInput[];
  ended: RuntimeSpanEndArgs[];
}

function capture(run: () => void): CapturedSpans {
  const opened: RuntimeSpanInput[] = [];
  const ended: RuntimeSpanEndArgs[] = [];
  const restore = _setTurnThermometerStarterForTests((input) => {
    opened.push(input);
    return { end: (args) => ended.push(args) };
  });
  try {
    run();
  } finally {
    restore();
  }
  return { opened, ended };
}

describe("phase thermometer readings (#902)", () => {
  test("other is the step wall-clock residual after generation and dispatch", () => {
    assert.equal(otherPhaseMs({ generationMs: 3000, dispatchMs: 2000, stepWallMs: 6000 }), 1000);
  });

  test("a residual never goes negative on clock skew between brackets", () => {
    assert.equal(otherPhaseMs({ generationMs: 3000, dispatchMs: 4000, stepWallMs: 6000 }), 0);
  });

  test("dispatch share rounds to whole percent and omits at zero wall-clock", () => {
    const reading = { generationMs: 3000, dispatchMs: 1000, stepWallMs: 6000 };
    // 1000 / (3000 + 1000 + 2000) = 16.67% → 17.
    assert.equal(dispatchSharePct(reading), 17);
    assert.equal(dispatchSharePct({ generationMs: 0, dispatchMs: 0, stepWallMs: 0 }), undefined);
  });
});

describe("emitTurnPhaseThermometer", () => {
  const reading = { generationMs: 3000, dispatchMs: 1500, stepWallMs: 5000 };

  test("opens one span under the stable name, backdated to the run start", () => {
    const startedAt = new Date("2026-08-26T00:00:00.000Z");
    const { opened } = capture(() =>
      emitTurnPhaseThermometer({
        runId: "run_1",
        startedAt,
        outcome: "completed",
        turns: 2,
        reading,
      }),
    );
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.name, RUNTIME_TURN_PHASES);
    assert.equal(opened[0]?.runId, "run_1");
    assert.equal(opened[0]?.startedAt, startedAt);
    assert.deepEqual(opened[0]?.metadata, { turns: 2 });
  });

  test("folds the three phase readings plus the precomputed dispatch share at end", () => {
    const { ended } = capture(() =>
      emitTurnPhaseThermometer({
        runId: "run_1",
        startedAt: undefined,
        outcome: "completed",
        turns: 1,
        reading,
      }),
    );
    assert.deepEqual(ended, [
      {
        status: "completed",
        metadata: {
          outcome: "completed",
          generationMs: 3000,
          dispatchMs: 1500,
          otherMs: 500,
          dispatchSharePct: 30,
        },
      },
    ]);
  });

  test("omits the share while the turn has no attributable wall-clock", () => {
    const { ended } = capture(() =>
      emitTurnPhaseThermometer({
        runId: "run_1",
        startedAt: undefined,
        outcome: "cancelled",
        turns: 0,
        reading: { generationMs: 0, dispatchMs: 0, stepWallMs: 0 },
      }),
    );
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.metadata?.dispatchSharePct, undefined);
  });

  test("a faulted turn closes at ERROR level", () => {
    const { ended } = capture(() =>
      emitTurnPhaseThermometer({
        runId: "run_1",
        startedAt: undefined,
        outcome: "failed",
        turns: 1,
        reading,
      }),
    );
    assert.equal(ended[0]?.status, "failed");
    assert.equal(ended[0]?.level, "ERROR");
  });

  test("buildTurnPhaseSpanInput backdates to the run start for derived duration", () => {
    const startedAt = new Date("2026-08-26T00:00:30.000Z");
    const input = buildTurnPhaseSpanInput({
      runId: "run_2",
      startedAt,
      outcome: "stopped",
      turns: 3,
      reading,
    });
    assert.equal(input.startedAt, startedAt);
    // No run-start stamp (legacy checkpoint) falls back to now rather than epoch.
    const fallback = buildTurnPhaseSpanInput({
      runId: "run_2",
      startedAt: undefined,
      outcome: "stopped",
      turns: 3,
      reading,
    });
    assert.ok(Number.isFinite(fallback.startedAt.getTime()));
  });
});

describe("park attribution (#902)", () => {
  test("interruptChatRun stamps the park kind off the wake condition", () => {
    const joined = interruptChatRun(state(), [], { kind: "signal", name: "sub-agent-join:x" });
    assert.equal(joined.state.parkKind, "join");
    const gated = interruptChatRun(state(), [], { kind: "hil", approvalId: "ap_1" });
    assert.equal(gated.state.parkKind, "gate");
  });

  test("a join park folds into dispatchMs on resume", () => {
    const parked = state({ parkedAt: "2026-08-26T00:00:10.000Z", parkKind: "join" });
    const folded = foldResumedPark(parked, Date.parse("2026-08-26T00:01:00.000Z"));
    assert.equal(folded, 50_000);
    assert.equal(parked.dispatchMs, 50_000);
    // The markers clear so a later park stamps fresh.
    assert.equal(parked.parkedAt, undefined);
    assert.equal(parked.parkKind, undefined);
  });

  test("a gate (approval) park stays out of dispatchMs — human time, not machine work", () => {
    const parked = state({ parkedAt: "2026-08-26T00:00:10.000Z", parkKind: "gate" });
    const folded = foldResumedPark(parked, Date.parse("2026-08-26T00:01:00.000Z"));
    assert.equal(folded, 50_000);
    assert.equal(parked.dispatchMs, 0);
    assert.equal(parked.parkedAt, undefined);
  });

  test("resuming without a stamped park is a no-op", () => {
    const resumed = state();
    assert.equal(foldResumedPark(resumed, Date.now()), 0);
    assert.equal(resumed.dispatchMs, 0);
  });

  test("a park stamp from the future (clock skew) attributes nothing", () => {
    const parked = state({ parkedAt: "2026-08-26T00:00:10.000Z", parkKind: "join" });
    const folded = foldResumedPark(parked, Date.parse("2026-08-26T00:00:00.000Z"));
    assert.equal(folded, 0);
    assert.equal(parked.dispatchMs, 0);
    assert.equal(parked.parkedAt, undefined);
  });
});
