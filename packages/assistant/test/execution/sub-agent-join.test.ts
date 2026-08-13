import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { joinChildRun, type JoinChildRunDeps } from "@alfred/assistant/execution/sub-agent-join";
import { AWAIT_SUB_AGENT_CEILING_MS } from "@alfred/assistant/execution/sub-agent-join-wake-queue";
import type { ChildRunOutcome } from "@alfred/assistant/execution/sub-agents";

const args = { parentRunId: "run_parent", userId: "user_1", childRunId: "run_child" };
const running = { ok: true, done: false, status: "running", runningMs: 1_000 };

function dependencies(input: {
  scheduleResult: "scheduled" | "disabled" | "failed";
  outcome?: ChildRunOutcome;
  calls: string[];
}): JoinChildRunDeps {
  return {
    readOutcome: (request) => {
      input.calls.push(`read:${request.childRunId}`);
      return Promise.resolve(input.outcome ?? running);
    },
    scheduleWake: (request) => {
      input.calls.push(`schedule:${request.childRunId}:${request.delayMs}`);
      return Promise.resolve(input.scheduleResult);
    },
  };
}

describe("sub-agent join park safety", () => {
  test("schedules the dead-man wake before returning a park result", async () => {
    const calls: string[] = [];
    const result = await joinChildRun(args, dependencies({ scheduleResult: "scheduled", calls }));

    assert.deepEqual(calls, ["read:run_child", `schedule:run_child:${AWAIT_SUB_AGENT_CEILING_MS}`]);
    assert.equal(result.kind, "park");
  });

  test("refuses to park when the dead-man wake cannot be scheduled", async () => {
    const calls: string[] = [];
    const result = await joinChildRun(args, dependencies({ scheduleResult: "failed", calls }));

    assert.equal(result.kind, "resolved");
    if (result.kind !== "resolved") assert.fail("join must resolve after schedule failure");
    assert.equal(result.outcome.reason, "join_timer_unavailable");
  });

  test("returns a terminal child without scheduling a wake", async () => {
    const calls: string[] = [];
    const outcome = {
      ok: true,
      done: true,
      status: "completed",
      output: { answer: 42 },
    } satisfies ChildRunOutcome;
    const result = await joinChildRun(
      args,
      dependencies({ scheduleResult: "scheduled", outcome, calls }),
    );

    assert.deepEqual(result, { kind: "resolved", outcome });
    assert.deepEqual(calls, ["read:run_child"]);
  });
});
