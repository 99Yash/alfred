import type { SafeToParkSignal } from "@alfred/assistant/tool-runtime";

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
 * How a parent joins a child sub-agent. The sweep never resumes `waiting` runs,
 * so a park without its dead-man timer never wakes. Only this module can build the `park` arm,
 * and only after the timer is scheduled.
 */
export type JoinChildRunResult =
  | { kind: "resolved"; outcome: ChildRunOutcome }
  | { kind: "park"; signalName: ParkSignal };

/**
 * A `sub_agent_done` signal whose dead-man wake is scheduled. A raw signal wake condition
 * can still bypass it, so join through {@link joinChildRun}.
 */
export type ParkSignal = SafeToParkSignal;

function mintParkSignal(childRunId: string): ParkSignal {
  // SAFETY: the only mint; it runs after the timer is scheduled.
  return subAgentDoneSignalName(childRunId) as ParkSignal;
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

  // Schedule the dead-man wake before parking. The child's own signal can be lost
  // in a race, skipped by a cancel, or dropped by a crash.
  const scheduled = await deps.scheduleWake({
    childRunId: args.childRunId,
    parentRunId: args.parentRunId,
    delayMs: AWAIT_SUB_AGENT_CEILING_MS,
  });

  if (scheduled !== "scheduled") {
    // No timer means no safe park, so report the child as still running.
    console.warn(
      "[sub_agent_join] dead-man wake not scheduled (",
      scheduled,
      ") — refusing to park",
      args.childRunId,
    );

    return { kind: "resolved", outcome: { ...outcome, reason: "join_timer_unavailable" } };
  }

  return { kind: "park", signalName: mintParkSignal(args.childRunId) };
}
