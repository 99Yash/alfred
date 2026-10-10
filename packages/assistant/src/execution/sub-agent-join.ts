import type { SafeToParkWake } from "@alfred/assistant/tool-runtime";

import {
  AWAIT_SUB_AGENT_CEILING_MS,
  scheduleSubAgentJoinWakeJob,
} from "./sub-agent-join-wake-queue";
import { subAgentDoneSignalName } from "./sub-agent-metadata";
import {
  readChildRunOutcome,
  shouldResolveWithoutParking,
  type ChildRunOutcome,
} from "./sub-agents";

/**
 * How a parent joins a child sub-agent. The sweep never resumes `waiting` runs, so a park
 * needs a backstop. Only this module can build the `park` arm, and its wake carries the
 * deadline that the join reconciler reads from Postgres.
 */
export type JoinChildRunResult =
  | { kind: "resolved"; outcome: ChildRunOutcome }
  | { kind: "park"; wake: ParkWake };

/**
 * A `sub_agent_done` signal wake with a persisted deadline. A raw signal wake condition
 * can still bypass it, so join through {@link joinChildRun}.
 */
export type ParkWake = SafeToParkWake;

function mintParkWake(childRunId: string, deadlineAt: string): ParkWake {
  // SAFETY: the only mint; every park it builds carries a deadline.
  return { kind: "signal", name: subAgentDoneSignalName(childRunId), deadlineAt } as ParkWake;
}

/** Injected so the protocol is testable without a DB or Redis. */
export interface JoinChildRunDeps {
  readOutcome: typeof readChildRunOutcome;
  scheduleWake: typeof scheduleSubAgentJoinWakeJob;
}

const defaultJoinChildRunDeps: JoinChildRunDeps = {
  readOutcome: readChildRunOutcome,
  scheduleWake: scheduleSubAgentJoinWakeJob,
};

export async function joinChildRun(
  args: { parentRunId: string; userId: string; childRunId: string },
  deps: JoinChildRunDeps = defaultJoinChildRunDeps,
): Promise<JoinChildRunResult> {
  const outcome = await deps.readOutcome(args);

  // Past the ceiling the child is reported, not parked again, so a stuck child cannot loop.
  if (shouldResolveWithoutParking(outcome)) return { kind: "resolved", outcome };

  // The child's own signal can be lost in a race, skipped by a cancel, or dropped by a crash.
  // The Redis job is the fast path. The deadline in the wake is the backstop if the job is lost.
  const deadlineAt = new Date(Date.now() + AWAIT_SUB_AGENT_CEILING_MS).toISOString();
  await deps.scheduleWake({
    childRunId: args.childRunId,
    parentRunId: args.parentRunId,
    delayMs: AWAIT_SUB_AGENT_CEILING_MS,
  });

  return { kind: "park", wake: mintParkWake(args.childRunId, deadlineAt) };
}
