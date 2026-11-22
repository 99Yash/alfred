import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  joinSpawnedChildren,
  type JoinSpawnedChildrenDeps,
} from "@alfred/assistant/execution/sub-agent-join";
import { AWAIT_SUB_AGENT_CEILING_MS } from "@alfred/assistant/execution/sub-agent-join-wake-queue";
import type { ChildRunOutcome } from "@alfred/assistant/execution/sub-agent-children";

const args = { parentRunId: "run_parent", userId: "user_1", foldedChildRunIds: [] };

const NOW = new Date("2026-11-22T00:00:00.000Z");

const running = {
  kind: "live",
  status: "running",
  deadlineAt: new Date(NOW.getTime() + AWAIT_SUB_AGENT_CEILING_MS),
} satisfies ChildRunOutcome;

function dependencies(outcome: ChildRunOutcome, calls: string[]): JoinSpawnedChildrenDeps {
  return {
    listChildren: () => Promise.resolve([{ id: "run_child", parentRunId: "run_parent", outcome }]),
    scheduleWake: (request) => {
      calls.push(`schedule:${request.childRunId}:${request.delayMs}`);

      return Promise.resolve();
    },
    now: () => NOW,
  };
}

describe("sub-agent join park safety", () => {
  test("schedules the dead-man wake before returning a park result", async () => {
    const calls: string[] = [];
    const join = await joinSpawnedChildren(args, dependencies(running, calls));

    assert.deepEqual(calls, [`schedule:run_child:${AWAIT_SUB_AGENT_CEILING_MS}`]);
    assert.equal(join.park?.name, "sub_agent_done:run_child");
    assert.deepEqual(join.notes, []);
  });

  test("folds a terminal child without scheduling a wake", async () => {
    const calls: string[] = [];

    const outcome = {
      kind: "ended",
      status: "completed",
      output: { answer: 42 },
      error: null,
    } satisfies ChildRunOutcome;

    const join = await joinSpawnedChildren(args, dependencies(outcome, calls));

    assert.equal(join.park, null);
    assert.deepEqual(join.foldedChildRunIds, ["run_child"]);
    assert.match(join.notes[0]?.instruction ?? "", /finished — it completed/);
    assert.deepEqual(calls, []);
  });
});
