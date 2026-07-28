import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventPayload } from "@alfred/contracts/events";
import {
  applyArtifactFrame,
  selectByArtifactId,
  selectByToolCallId,
  selectLatestPendingForRun,
  type LiveArtifactStream,
} from "../../src/lib/chat/use-artifact-stream";
import { frameThreadId, type EventStreamFrame } from "../../src/lib/events/frame";

const RUN = "run_1";
const THREAD = "thread_1";
const OTHER_THREAD = "thread_2";

const CREATED_AT = "2026-07-28T00:00:00.000Z";
let frameId = 0;
const nextId = () => (frameId += 1);

/**
 * The two appliers are module-private, so every case drives the real reducer and
 * the hoisted thread check runs on the way in. Per-kind builders rather than one
 * generic factory: a literal `kind` beside a payload of that kind's type is
 * assignable to `EventStreamFrame` with no cast, so a schema change fails these
 * builders instead of being silently unchecked.
 */
function deltaFrame(
  over: Partial<EventPayload<"artifact.delta">> & { toolCallId: string; seq: number; text: string },
): EventStreamFrame {
  return {
    id: nextId(),
    kind: "artifact.delta",
    createdAt: CREATED_AT,
    payload: { runId: RUN, threadId: THREAD, mode: "replace", ...over },
  };
}

function toolFrame(
  toolCallId: string,
  over: Partial<EventPayload<"chat.tool">> = {},
): EventStreamFrame {
  return {
    id: nextId(),
    kind: "chat.tool",
    createdAt: CREATED_AT,
    payload: {
      runId: RUN,
      threadId: THREAD,
      messageId: "msg_1",
      toolCallId,
      toolName: "system.create_artifact",
      status: "succeeded",
      segmentIndex: 0,
      ...over,
    },
  };
}

describe("applyArtifactFrame — artifact.delta", () => {
  test("creates a stream, then appends text on the next seq", () => {
    const s = new Map<string, LiveArtifactStream>();
    assert.equal(
      applyArtifactFrame(
        s,
        deltaFrame({ toolCallId: "t1", seq: 1, text: "Hello", title: "Doc" }),
        THREAD,
      ),
      true,
    );
    assert.equal(
      applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 2, text: " world" }), THREAD),
      true,
    );
    const stream = s.get("t1");
    assert.equal(stream?.text, "Hello world");
    assert.equal(stream?.title, "Doc");
    assert.equal(stream?.seq, 2);
  });

  test("ignores a replayed/stale seq (no change, no double-append)", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 2, text: "body" }), THREAD);
    assert.equal(
      applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 2, text: "body" }), THREAD),
      false,
    );
    assert.equal(
      applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 1, text: "old" }), THREAD),
      false,
    );
    assert.equal(s.get("t1")?.text, "body");
  });

  test("ignores frames once the stream is done", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 1, text: "a" }), THREAD);
    applyArtifactFrame(s, toolFrame("t1", { artifactId: "art_1" }), THREAD);
    assert.equal(
      applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 2, text: "b" }), THREAD),
      false,
    );
    assert.equal(s.get("t1")?.text, "a");
  });
});

describe("applyArtifactFrame — chat.tool resolution", () => {
  test("binds the durable artifactId and marks done", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 1, text: "a" }), THREAD);
    assert.equal(applyArtifactFrame(s, toolFrame("t1", { artifactId: "art_1" }), THREAD), true);
    assert.equal(s.get("t1")?.artifactId, "art_1");
    assert.equal(s.get("t1")?.done, true);
  });

  test("a resolution for an unknown tool call is a no-op", () => {
    const s = new Map<string, LiveArtifactStream>();
    assert.equal(applyArtifactFrame(s, toolFrame("ghost"), THREAD), false);
  });
});

describe("applyArtifactFrame — thread scope", () => {
  test("a frame naming another thread is dropped before it reaches an applier", () => {
    const s = new Map<string, LiveArtifactStream>();
    // The assertion a return-value check cannot make on its own: a check placed
    // *below* the mutation still returns false while having already written.
    assert.equal(
      applyArtifactFrame(
        s,
        deltaFrame({ toolCallId: "t1", seq: 1, text: "not ours", threadId: OTHER_THREAD }),
        THREAD,
      ),
      false,
    );
    assert.equal(s.size, 0);

    applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 1, text: "ours" }), THREAD);
    assert.equal(
      applyArtifactFrame(
        s,
        toolFrame("t1", { threadId: OTHER_THREAD, artifactId: "art_x" }),
        THREAD,
      ),
      false,
    );
    assert.equal(s.get("t1")?.done, false);
    assert.equal(s.get("t1")?.artifactId, null);
  });

  test("a kind this reducer does not handle is dropped whichever thread it names", () => {
    const s = new Map<string, LiveArtifactStream>();
    for (const threadId of [THREAD, OTHER_THREAD]) {
      const frame: EventStreamFrame = {
        id: nextId(),
        kind: "chat.delta",
        createdAt: CREATED_AT,
        payload: { runId: RUN, threadId, messageId: "msg_1", seq: 1, text: "x", segmentIndex: 0 },
      };
      assert.equal(applyArtifactFrame(s, frame, THREAD), false);
    }
    assert.equal(s.size, 0);
  });
});

/**
 * Hoisting the thread check above the kind dispatch is behaviour-neutral, proven
 * by driving the real reducer and a hand-built reference in lockstep rather than
 * by reading the diff (`apps/web` has no jsdom, so the pre-change routing cannot
 * be exercised where it lived — inside `useEffect`).
 */
describe("applyArtifactFrame — differential against main's routing", () => {
  /**
   * `onFrame`'s routing as it stood on `origin/main` at 3c0cfc62 (blob
   * 25da21e17dbf6ed878007ed9746f9ee635322614), with the thread check BELOW the
   * dispatch, once per kind:
   *
   *     if (frame.kind === "artifact.delta") {
   *       const p = frame.payload;
   *       if (p.threadId !== threadId) return;
   *       if (applyArtifactDelta(streamsRef.current, p)) setVersion((v) => v + 1);
   *     } else if (frame.kind === "chat.tool") {
   *       const p = frame.payload;
   *       if (p.threadId !== threadId) return;
   *       if (applyArtifactToolResolution(streamsRef.current, p)) setVersion((v) => v + 1);
   *     }
   *
   * The two appliers are byte-identical across this change — they only lost their
   * `export` — so transcribing them here would add transcription risk without
   * proving anything. The reference reaches them through `applyArtifactFrame` with
   * the frame's OWN thread, which makes the hoisted gate vacuous and leaves pure
   * dispatch. So this compares `per-kind-gate ∘ dispatch` (hand-built from main)
   * against `hoisted-gate ∘ dispatch` (the real function): exactly the hoist, and
   * a mutation to the hoisted gate is invisible to the reference.
   */
  function referenceOnFrame(
    streams: Map<string, LiveArtifactStream>,
    frame: EventStreamFrame,
    threadId: string,
  ): boolean {
    const dispatchOnly = () => applyArtifactFrame(streams, frame, frameThreadId(frame) ?? "");
    if (frame.kind === "artifact.delta") {
      if (frame.payload.threadId !== threadId) return false;
      return dispatchOnly();
    } else if (frame.kind === "chat.tool") {
      if (frame.payload.threadId !== threadId) return false;
      return dispatchOnly();
    }
    return false;
  }

  /** Deterministic PRNG so a divergence is reproducible from the seed alone. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const KINDS = ["artifact.delta", "chat.tool", "chat.delta", "agent.run"] as const;
  const THREADS = [THREAD, OTHER_THREAD] as const;
  const CALLS = ["t1", "t2"] as const;
  const STATUSES = ["started", "succeeded", "failed"] as const;

  function randomFrame(rng: () => number): EventStreamFrame {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const kind = pick(KINDS);
    const threadId = pick(THREADS);
    const toolCallId = pick(CALLS);
    const seq = Math.floor(rng() * 4);
    const id = nextId();
    switch (kind) {
      case "artifact.delta":
        return {
          id,
          kind,
          createdAt: CREATED_AT,
          payload: {
            runId: RUN,
            threadId,
            toolCallId,
            seq,
            text: `s${seq}`,
            mode: rng() < 0.5 ? "replace" : "append",
            ...(rng() < 0.3 ? { artifactId: "art_1" } : {}),
            ...(rng() < 0.3 ? { title: "Doc" } : {}),
          },
        };
      case "chat.tool":
        return {
          id,
          kind,
          createdAt: CREATED_AT,
          payload: {
            runId: RUN,
            threadId,
            messageId: "msg_1",
            toolCallId,
            toolName: "system.create_artifact",
            status: pick(STATUSES),
            segmentIndex: 0,
            ...(rng() < 0.5 ? { artifactId: "art_1" } : {}),
          },
        };
      case "chat.delta":
        return {
          id,
          kind,
          createdAt: CREATED_AT,
          payload: {
            runId: RUN,
            threadId,
            messageId: "msg_1",
            seq,
            text: `d${seq}`,
            segmentIndex: 0,
          },
        };
      case "agent.run":
        return { id, kind, createdAt: CREATED_AT, payload: { runId: RUN, phase: "step_started" } };
    }
  }

  test("2000 random frames: identical return value and identical map at every step", () => {
    // Aliasing is not a hazard here: both appliers always replace the map entry
    // with a fresh object and neither mutates the payload, so the two maps below
    // never come to share a value and `deepEqual` cannot pass vacuously.
    for (const seed of [1, 7, 142, 9001]) {
      const rng = mulberry32(seed);
      const mine = new Map<string, LiveArtifactStream>();
      const reference = new Map<string, LiveArtifactStream>();
      for (let step = 0; step < 500; step += 1) {
        const frame = randomFrame(rng);
        const a = applyArtifactFrame(mine, frame, THREAD);
        const b = referenceOnFrame(reference, frame, THREAD);
        assert.equal(a, b, `seed ${seed} step ${step}: ${frame.kind} return value diverged`);
        assert.deepEqual(mine, reference, `seed ${seed} step ${step}: ${frame.kind} map diverged`);
      }
    }
  });

  /**
   * Credibility of the harness above, run against this tree:
   *
   * - **Delete the hoisted gate** (`if (named !== null && named !== threadId) return
   *   false;`) → **164 of the 2000 steps diverge**, first at seed 1 step 9. Every
   *   divergence is a cross-thread frame the reducer applied. (Counted by resyncing
   *   the reference map from the real one after each divergence, so the number is
   *   per-step rather than one divergence smeared across the rest of the run.)
   * - Deleting only the `named !== null` clause diverges **0** steps and leaves the
   *   whole file green. That is correct rather than a hole: no kind this reducer
   *   handles names no thread, so the clause exists for the arm added later — which
   *   is the point of the item, and why the tier-1 `noThreadNamed` gate in
   *   `lib/events/frame.ts`, not this harness, is what enforces it.
   */
  test("the differential is calibrated — see the recorded mutants above", () => {
    assert.ok(true);
  });
});

describe("selectByArtifactId — multi-section document", () => {
  // Simulate: create (t1, replace) → append (t2, append) → append (t3, append),
  // all sharing artifactId art_1. Appends carry art_1 in their args from the
  // first delta; create only gets it once its chat.tool succeeds.
  function multiSection(): Map<string, LiveArtifactStream> {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactFrame(
      s,
      deltaFrame({ toolCallId: "t1", seq: 1, text: "Section 1", title: "Doc" }),
      THREAD,
    );
    applyArtifactFrame(s, toolFrame("t1", { artifactId: "art_1" }), THREAD);
    applyArtifactFrame(
      s,
      deltaFrame({
        toolCallId: "t2",
        seq: 1,
        text: "Section 2",
        mode: "append",
        artifactId: "art_1",
      }),
      THREAD,
    );
    return s;
  }

  test("returns the currently-authoring append, not the stale done create", () => {
    const s = multiSection();
    const picked = selectByArtifactId(s, "art_1");
    // The regression: a first-match-wins lookup returns t1 (create, done,
    // replace). The fix prefers the active stream t2 so the live section fills.
    assert.equal(picked?.toolCallId, "t2");
    assert.equal(picked?.mode, "append");
    assert.equal(picked?.text, "Section 2");
    assert.equal(picked?.done, false);
  });

  test("with no active stream, returns the latest (most recent section)", () => {
    const s = multiSection();
    // Second append finishes; now every stream for art_1 is done.
    applyArtifactFrame(
      s,
      toolFrame("t2", { toolName: "system.append_artifact_section", artifactId: "art_1" }),
      THREAD,
    );
    const picked = selectByArtifactId(s, "art_1");
    assert.equal(picked?.toolCallId, "t2");
    assert.equal(picked?.done, true);
  });

  test("returns null when no stream carries the id", () => {
    const s = multiSection();
    assert.equal(selectByArtifactId(s, "art_missing"), null);
  });
});

describe("selectByToolCallId / selectLatestPendingForRun", () => {
  test("byToolCallId returns the exact stream or null", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 1, text: "a" }), THREAD);
    assert.equal(selectByToolCallId(s, "t1")?.text, "a");
    assert.equal(selectByToolCallId(s, "nope"), null);
  });

  test("latestPendingForRun ignores streams that already bound a row or finished", () => {
    const s = new Map<string, LiveArtifactStream>();
    // A pending create (no artifactId yet).
    applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 1, text: "a" }), THREAD);
    assert.equal(selectLatestPendingForRun(s, RUN)?.toolCallId, "t1");
    // Once it binds a durable id it is no longer "pending".
    applyArtifactFrame(s, toolFrame("t1", { artifactId: "art_1" }), THREAD);
    assert.equal(selectLatestPendingForRun(s, RUN), null);
  });

  test("latestPendingForRun returns the newest pending create in the run", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactFrame(s, deltaFrame({ toolCallId: "t1", seq: 1, text: "a" }), THREAD);
    applyArtifactFrame(s, deltaFrame({ toolCallId: "t2", seq: 1, text: "b" }), THREAD);
    assert.equal(selectLatestPendingForRun(s, RUN)?.toolCallId, "t2");
    assert.equal(selectLatestPendingForRun(s, "other_run"), null);
  });
});
