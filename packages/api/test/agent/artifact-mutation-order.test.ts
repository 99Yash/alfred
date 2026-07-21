import assert from "node:assert/strict";
import test from "node:test";

import type { DispatchResult } from "../../src/modules/dispatch";
import { ARTIFACT_MUTATION_TOOL_NAMES } from "../../src/modules/agent/workflows/chat-turn";
import { runToolRound } from "../../src/modules/agent/workflows/tool-round";

// Exercised through the production entry point (`runToolRound` in its
// `concurrent-autonomy` mode) rather than the private lane-splitter it wraps, so
// the concurrency guarantee is pinned where chat actually consumes it.

type Call = { toolCallId: string; toolName: string; input: unknown };

// Chat's real "must run in model order" predicate — artifact mutations share
// document body state, so they serialize among themselves while every other
// autonomy call overlaps.
const artifactMutations: ReadonlySet<string> = new Set(ARTIFACT_MUTATION_TOOL_NAMES);
const serializeInOrder = (call: Call) => artifactMutations.has(call.toolName);

const executed = (id: string): DispatchResult => ({
  kind: "executed",
  stagingId: null,
  toolResult: { id },
  editedByUser: false,
});

/** Let both dispatch lanes drain up to the next blocked call. `runToolRound`
 *  wraps the lane-splitter in a couple more async hops than a direct call, so
 *  flush generously; the observable event order is unaffected. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test("artifact mutations serialize in model order without blocking independent calls", async () => {
  const calls: Call[] = [
    { toolCallId: "lookup", toolName: "system.web_search", input: {} },
    { toolCallId: "page-1", toolName: "system.append_artifact_page", input: {} },
    { toolCallId: "page-2", toolName: "system.append_artifact_page", input: {} },
  ];
  const events: string[] = [];
  const committed: string[] = [];
  let releaseLookup!: () => void;
  const lookupReleased = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });

  const run = runToolRound<Call>({
    calls,
    transcript: [],
    batchSpan: null,
    ordering: { kind: "concurrent-autonomy", gateFlags: [false, false, false], serializeInOrder },
    dispatch: async (call) => {
      events.push(`start:${call.toolCallId}`);
      if (call.toolCallId === "lookup") await lookupReleased;
      await Promise.resolve();
      events.push(`end:${call.toolCallId}`);
      return executed(call.toolCallId);
    },
    onCommit: (call) => {
      committed.push(call.toolCallId);
    },
  });

  // Let both lanes advance. The blocked lookup must not hold page authoring,
  // while page 2 must not begin until page 1 has committed.
  await flushMicrotasks();
  assert.deepEqual(events, [
    "start:lookup",
    "start:page-1",
    "end:page-1",
    "start:page-2",
    "end:page-2",
  ]);

  releaseLookup();
  const outcome = await run;
  assert.equal(outcome.kind, "committed");
  // Commit pass runs in model order regardless of dispatch overlap.
  assert.deepEqual(committed, ["lookup", "page-1", "page-2"]);
});

test("document section appends serialize in model order (ADR-0085)", async () => {
  // Sections concatenate onto one shared body, so out-of-order dispatch would
  // scramble the document even though the row lock prevents lost writes.
  const calls: Call[] = [
    { toolCallId: "create", toolName: "system.create_artifact", input: {} },
    { toolCallId: "section-1", toolName: "system.append_artifact_section", input: {} },
    { toolCallId: "lookup", toolName: "system.web_search", input: {} },
    { toolCallId: "section-2", toolName: "system.append_artifact_section", input: {} },
  ];
  const events: string[] = [];
  let releaseCreate!: () => void;
  const createReleased = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });

  const run = runToolRound<Call>({
    calls,
    transcript: [],
    batchSpan: null,
    ordering: {
      kind: "concurrent-autonomy",
      gateFlags: [false, false, false, false],
      serializeInOrder,
    },
    dispatch: async (call) => {
      events.push(`start:${call.toolCallId}`);
      if (call.toolCallId === "create") await createReleased;
      await Promise.resolve();
      events.push(`end:${call.toolCallId}`);
      return executed(call.toolCallId);
    },
  });

  // The independent lookup is dispatched first and runs to completion; every
  // artifact mutation waits its turn behind the blocked create, so neither
  // section can begin until create commits.
  await flushMicrotasks();
  assert.deepEqual(events, ["start:lookup", "start:create", "end:lookup"]);

  releaseCreate();
  const outcome = await run;
  assert.equal(outcome.kind, "committed");
  assert.deepEqual(events, [
    "start:lookup",
    "start:create",
    "end:lookup",
    "end:create",
    "start:section-1",
    "end:section-1",
    "start:section-2",
    "end:section-2",
  ]);
});
