import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventPayload } from "@alfred/contracts/events";
import {
  applyArtifactDelta,
  applyArtifactToolResolution,
  selectByArtifactId,
  selectByToolCallId,
  selectLatestPendingForRun,
  type LiveArtifactStream,
} from "../../src/lib/chat/use-artifact-stream";

const RUN = "run_1";
const THREAD = "thread_1";

function delta(
  over: Partial<EventPayload<"artifact.delta">> & { toolCallId: string; seq: number; text: string },
): EventPayload<"artifact.delta"> {
  return {
    runId: RUN,
    threadId: THREAD,
    mode: "replace",
    ...over,
  } as EventPayload<"artifact.delta">;
}

function toolResolved(
  toolCallId: string,
  over: Partial<EventPayload<"chat.tool">> = {},
): EventPayload<"chat.tool"> {
  return {
    runId: RUN,
    threadId: THREAD,
    messageId: "msg_1",
    toolCallId,
    toolName: "system.create_artifact",
    status: "succeeded",
    segmentIndex: 0,
    ...over,
  } as EventPayload<"chat.tool">;
}

describe("applyArtifactDelta", () => {
  test("creates a stream, then appends text on the next seq", () => {
    const s = new Map<string, LiveArtifactStream>();
    assert.equal(applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 1, text: "Hello", title: "Doc" })), true);
    assert.equal(applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 2, text: " world" })), true);
    const stream = s.get("t1");
    assert.equal(stream?.text, "Hello world");
    assert.equal(stream?.title, "Doc");
    assert.equal(stream?.seq, 2);
  });

  test("ignores a replayed/stale seq (no change, no double-append)", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 2, text: "body" }));
    assert.equal(applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 2, text: "body" })), false);
    assert.equal(applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 1, text: "old" })), false);
    assert.equal(s.get("t1")?.text, "body");
  });

  test("ignores frames once the stream is done", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 1, text: "a" }));
    applyArtifactToolResolution(s, toolResolved("t1", { artifactId: "art_1" }));
    assert.equal(applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 2, text: "b" })), false);
    assert.equal(s.get("t1")?.text, "a");
  });
});

describe("applyArtifactToolResolution", () => {
  test("binds the durable artifactId and marks done", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 1, text: "a" }));
    assert.equal(applyArtifactToolResolution(s, toolResolved("t1", { artifactId: "art_1" })), true);
    assert.equal(s.get("t1")?.artifactId, "art_1");
    assert.equal(s.get("t1")?.done, true);
  });

  test("a resolution for an unknown tool call is a no-op", () => {
    const s = new Map<string, LiveArtifactStream>();
    assert.equal(applyArtifactToolResolution(s, toolResolved("ghost")), false);
  });
});

describe("selectByArtifactId — multi-section document", () => {
  // Simulate: create (t1, replace) → append (t2, append) → append (t3, append),
  // all sharing artifactId art_1. Appends carry art_1 in their args from the
  // first delta; create only gets it once its chat.tool succeeds.
  function multiSection(): Map<string, LiveArtifactStream> {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 1, text: "Section 1", title: "Doc" }));
    applyArtifactToolResolution(s, toolResolved("t1", { artifactId: "art_1" }));
    applyArtifactDelta(
      s,
      delta({ toolCallId: "t2", seq: 1, text: "Section 2", mode: "append", artifactId: "art_1" }),
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
    applyArtifactToolResolution(s, toolResolved("t2", { toolName: "system.append_artifact_section", artifactId: "art_1" }));
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
    applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 1, text: "a" }));
    assert.equal(selectByToolCallId(s, "t1")?.text, "a");
    assert.equal(selectByToolCallId(s, "nope"), null);
  });

  test("latestPendingForRun ignores streams that already bound a row or finished", () => {
    const s = new Map<string, LiveArtifactStream>();
    // A pending create (no artifactId yet).
    applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 1, text: "a" }));
    assert.equal(selectLatestPendingForRun(s, RUN)?.toolCallId, "t1");
    // Once it binds a durable id it is no longer "pending".
    applyArtifactToolResolution(s, toolResolved("t1", { artifactId: "art_1" }));
    assert.equal(selectLatestPendingForRun(s, RUN), null);
  });

  test("latestPendingForRun returns the newest pending create in the run", () => {
    const s = new Map<string, LiveArtifactStream>();
    applyArtifactDelta(s, delta({ toolCallId: "t1", seq: 1, text: "a" }));
    applyArtifactDelta(s, delta({ toolCallId: "t2", seq: 1, text: "b" }));
    assert.equal(selectLatestPendingForRun(s, RUN)?.toolCallId, "t2");
    assert.equal(selectLatestPendingForRun(s, "other_run"), null);
  });
});
