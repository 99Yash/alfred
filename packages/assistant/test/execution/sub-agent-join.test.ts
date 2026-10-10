import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { joinChildRun, type JoinChildRunDeps } from "@alfred/assistant/execution/sub-agent-join";
import { AWAIT_SUB_AGENT_CEILING_MS } from "@alfred/assistant/execution/sub-agent-join-wake-queue";
import type { ChildRunOutcome } from "@alfred/assistant/execution/sub-agents";

const args = { parentRunId: "run_parent", userId: "user_1", childRunId: "run_child" };

const running = { ok: true, done: false, status: "running", runningMs: 1_000 };

function dependencies(input: { outcome?: ChildRunOutcome; calls: string[] }): JoinChildRunDeps {
  return {
    readOutcome: (request) => {
      input.calls.push(`read:${request.childRunId}`);

      return Promise.resolve(input.outcome ?? running);
    },
    scheduleWake: (request) => {
      input.calls.push(`schedule:${request.childRunId}:${request.delayMs}`);

      return Promise.resolve();
    },
  };
}

describe("sub-agent join park safety", () => {
  test("schedules the dead-man wake before returning a park result", async () => {
    const calls: string[] = [];
    const result = await joinChildRun(args, dependencies({ calls }));

    assert.deepEqual(calls, ["read:run_child", `schedule:run_child:${AWAIT_SUB_AGENT_CEILING_MS}`]);
    assert.equal(result.kind, "park");
  });

  test("returns a terminal child without scheduling a wake", async () => {
    const calls: string[] = [];

    const outcome = {
      ok: true,
      done: true,
      status: "completed",
      output: { answer: 42 },
    } satisfies ChildRunOutcome;

    const result = await joinChildRun(args, dependencies({ outcome, calls }));

    assert.deepEqual(result, { kind: "resolved", outcome });
    assert.deepEqual(calls, ["read:run_child"]);
  });
});
